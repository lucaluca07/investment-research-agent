export function Composer({ value, onChange, onSend, onStop, active, disabled }: { value: string; onChange: (value: string) => void; onSend: () => void; onStop: () => void; active: boolean; disabled?: boolean }) {
  return <form onSubmit={(event) => { event.preventDefault(); onSend(); }}><textarea aria-label="研究问题" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} placeholder="输入研究问题" />{active ? <button type="button" onClick={onStop}>停止</button> : <button type="submit" disabled={disabled || !value.trim()}>发送</button>}</form>;
}
