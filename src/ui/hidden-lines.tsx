// Notice for credential-like lines: hidden by default, shown only on explicit request, never sent to the model.
export function HiddenLines({ count, revealed, onToggle }: { count: number; revealed: boolean; onToggle: () => void }) {
  if (!count) return null;
  const text = revealed ? 'Se muestran las líneas que parecen claves. Al modelo se siguen enviando ocultas.'
    : `${count === 1 ? '1 línea parece una clave y está oculta' : `${count} líneas parecen claves y están ocultas`}; nunca se envían al modelo.`;
  return <p className="notice hidden-lines">{text} <button aria-pressed={revealed} aria-label={revealed ? 'Ocultar líneas que parecen claves' : 'Mostrar líneas que parecen claves'} onClick={onToggle}>{revealed ? 'Ocultar' : 'Mostrar'}</button></p>;
}
