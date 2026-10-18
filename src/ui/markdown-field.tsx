import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from 'react';

// The visual Markdown editor (CodeMirror) loads in its own chunk, only when an editor is opened. If that
// chunk cannot be loaded or the editor fails, a plain text box takes its place: the text is never lost.
const MarkdownEditor = lazy(() => import('./markdown-editor'));
type Props = ComponentProps<typeof MarkdownEditor>;

class Fallback extends Component<{ props: Props; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    const { value, onChange, label, disabled, minHeight = 160 } = this.props.props;
    return <div className="md-fallback">
      <small role="status">El editor visual no se pudo cargar; puedes seguir escribiendo aquí en Markdown.</small>
      <textarea aria-label={label} value={value} disabled={disabled} style={{ minHeight }} onChange={event => onChange(event.target.value)}/>
    </div>;
  }
}

export function MarkdownField(props: Props) {
  return <Fallback props={props}><Suspense fallback={<p className="md-loading" role="status">Cargando el editor…</p>}><MarkdownEditor {...props}/></Suspense></Fallback>;
}
