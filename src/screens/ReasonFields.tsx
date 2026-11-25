import { REASONS } from '../lib/reasons'

export type Reason = { code: string; note: string }
export const NO_REASON: Reason = { code: '', note: '' }

/** Fixed reason list. "Other" must come with a note (checked where the action is saved). */
export default function ReasonFields({ value, onChange }: { value: Reason; onChange: (r: Reason) => void }) {
  return (
    <>
      <select aria-label="Reason" value={value.code} onChange={(e) => onChange({ ...value, code: e.target.value })}>
        <option value="">Pick a reason</option>
        {REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>
      <input aria-label="Reason note" placeholder={value.code === 'other' ? 'What happened? (required)' : 'Note (optional)'} value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} />
    </>
  )
}
