// Labelled −/+ pixel-size stepper used by the Settings modal for the
// terminal and chat font sizes; the value is clamped to [min, max].
interface FontSizeStepperProps {
  label: string
  hint: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}

const STEP_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover disabled:opacity-50'

export default function FontSizeStepper({ label, hint, value, min, max, onChange }: FontSizeStepperProps) {
  return (
    <div className="mt-4 flex items-center justify-between">
      <div>
        <div className="text-sm text-primary">{label}</div>
        <div className="text-[10px] text-muted">{hint}</div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
          className={STEP_BUTTON_CLASS}
        >
          <span className="text-sm font-bold">−</span>
        </button>
        <span className="text-sm text-secondary w-6 text-center">{value}</span>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
          className={STEP_BUTTON_CLASS}
        >
          <span className="text-sm font-bold">+</span>
        </button>
      </div>
    </div>
  )
}
