//! Lines that look like credentials are hidden whole: in the interface by default and always before text
//! reaches the model. Hidden lines are numbered so an edited text can get them back. Same rules as the
//! former server/secret-lines.ts.

use std::sync::LazyLock;

use fancy_regex::Regex as Fancy;
use regex::Regex;

const QUOTE_OR_BOLD: &str = r#"["'*`]*"#;
/// Words that only ever name a credential: any value after them is hidden.
const STRONG_KEY: &str = r"(?<![A-Za-z])(?:api[_ -]?keys?|access[_ -]?keys?|private[_ -]?keys?|secret[_ -]?(?:access[_ -]?)?keys?|(?:auth|access|refresh|bearer)[_ -]?tokens?|authorization|passwords?|passwd|pwd|contraseñas?|credentials?|claves? (?:de api|api|secretas?|privadas?))(?![A-Za-z])";

fn fancy(pattern: &str) -> Fancy {
    fancy_regex::RegexBuilder::new(pattern).backtrack_limit(5_000_000).build().expect("patrón de claves")
}

static SECRET_LINES: LazyLock<Vec<Fancy>> = LazyLock::new(|| {
    // Everyday words ("Valores clave: honestidad"): hidden only when the value is one opaque token with a
    // digit or symbol.
    let weak = format!(
        r#"(?i)(?<![A-Za-z_])(?:tokens?|claves?|pass|pin|secret|secreto)(?![A-Za-z]){QUOTE_OR_BOLD}\s*[:=]\s*["'`]?(?=[^\s"'`]*[0-9!#$%&()*+./:;<=>?@^_~-])[^\s"'`]{{6,}}["'`]?[,;]?\s*$"#
    );
    [
        format!(r"(?i){STRONG_KEY}{QUOTE_OR_BOLD}\s*[:=]"),
        weak,
        r"(?i)(?<![A-Za-z])(?:mi |la |tu )?claves? (?:de )?api (?:es|son)(?![A-Za-z0-9_])".into(),
        r"(?i)(?<![A-Za-z0-9_])bearer\s+[A-Za-z0-9._~+/=-]{12,}".into(),
        r"(?i)(?<![A-Za-z0-9_])(?:sk-|sk_live_|ghp_|gho_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_\-]{8,}|(?<![A-Za-z0-9_])AKIA[0-9A-Z]{16}(?![A-Za-z0-9_])".into(),
        // user:password@host, with bounded repetitions so a long line cannot make the scan quadratic
        r"(?i)(?<![A-Za-z0-9_])[a-z][a-z0-9+.-]{0,31}://[^\s:/@]{1,256}:[^\s@]{1,256}@".into(),
    ]
    .iter()
    .map(|p| fancy(p))
    .collect()
});
/// Long opaque strings (keys, hashes): letters and digits with a 20-character run, outside links; plain
/// UUIDs and hyphenated slugs or snake_case names stay visible.
static OPAQUE: LazyLock<Fancy> = LazyLock::new(|| {
    fancy(r"(?<![A-Za-z0-9_+=-])(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_+=-]))(?=[A-Za-z0-9_+=-]*[0-9])(?=[A-Za-z0-9_+=-]*[A-Za-z])(?=[A-Za-z0-9_+=-]*[A-Za-z0-9+=]{20})[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])")
});
static KEY_AT_END: LazyLock<Fancy> = LazyLock::new(|| fancy(&format!(r"(?i){STRONG_KEY}{QUOTE_OR_BOLD}\s*[:=]\s*$")));
static LINKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://\S+|\[\[[^\]]*\]\]").unwrap());
pub static CONTROLS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]").unwrap());
static MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[línea oculta ([0-9]+)\]$").unwrap());
static PEM_BEGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-----BEGIN [A-Z ]+-----").unwrap());
static PEM_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-----END [A-Z ]+-----").unwrap());

pub fn hidden_marker(n: usize) -> String {
    format!("[línea oculta {n}]")
}

pub fn is_hidden_marker(line: &str) -> bool {
    MARKER.is_match(line.trim())
}

/// A pattern that gives up (too much backtracking) counts as a match: hiding is the safe answer.
fn matches(pattern: &Fancy, text: &str) -> bool {
    pattern.is_match(text).unwrap_or(true)
}

fn is_secret(line: &str) -> bool {
    SECRET_LINES.iter().any(|p| matches(p, line)) || matches(&OPAQUE, &LINKS.replace_all(line, " "))
}

pub struct Masked {
    pub text: String,
    pub hidden: Vec<String>,
}

/// Replaces every credential-like line (whole PEM blocks, and a value written on the line after its key)
/// with a numbered marker.
pub fn mask_secrets(raw: &str) -> Masked {
    let clean = CONTROLS.replace_all(raw, "");
    let mut hidden = Vec::new();
    let (mut pem, mut next) = (false, false);
    let lines: Vec<String> = clean
        .split('\n')
        .map(|line| {
            // Hermes' memory entry separator ends any pending block, so hiding never merges two entries.
            if line.trim() == "§" {
                pem = false;
                next = false;
                return line.to_string();
            }
            if PEM_BEGIN.is_match(line) {
                pem = true;
            }
            // A literal marker already in the text is hidden too, so restoring an edit can never confuse it
            // with a secret.
            let secret = pem || next || is_secret(line) || is_hidden_marker(line);
            next = !pem && matches(&KEY_AT_END, line);
            if PEM_END.is_match(line) {
                pem = false;
            }
            if !secret {
                return line.to_string();
            }
            hidden.push(line.to_string());
            hidden_marker(hidden.len())
        })
        .collect();
    Masked { text: lines.join("\n"), hidden }
}

#[derive(Debug, PartialEq)]
pub struct HiddenLineError;

impl std::fmt::Display for HiddenLineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("El texto incluye una marca de línea oculta que no existe. Vuelve a cargar el archivo.")
    }
}

impl std::error::Error for HiddenLineError {}

/// Puts the original lines back where the edited text kept their markers; removed markers delete the line.
pub fn restore_secrets(edited: &str, hidden: &[String]) -> Result<String, HiddenLineError> {
    edited
        .split('\n')
        .map(|line| match MARKER.captures(line.trim()) {
            None => Ok(line.to_string()),
            Some(found) => {
                let n: usize = found[1].parse().map_err(|_| HiddenLineError)?;
                n.checked_sub(1).and_then(|i| hidden.get(i)).cloned().ok_or(HiddenLineError)
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|lines| lines.join("\n"))
}

/// Text shown on explicit request: original lines, control characters removed.
pub fn reveal_secrets(raw: &str) -> String {
    CONTROLS.replace_all(raw, "").into_owned()
}
