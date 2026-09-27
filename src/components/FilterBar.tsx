import type { PlayerColor, TimeClass } from "../../shared/types";
import type { GameWindow } from "../../shared/window";
import type { ExplorerFilters } from "../hooks/useFilters";

interface Option<T> {
  value: T;
  label: string;
}

function Segmented<T extends string | null>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="limit-toggle filter-group" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          className={`limit-chip${value === option.value ? " limit-chip-active" : ""}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const colorOptions: Option<PlayerColor>[] = [
  { value: "white", label: "As White" },
  { value: "black", label: "As Black" }
];
const windowOptions: Option<GameWindow>[] = [
  { value: "6m", label: "6 mo" },
  { value: "3m", label: "3 mo" }
];
const timeClassOptions: Option<TimeClass | null>[] = [
  { value: null, label: "Blitz + Rapid" },
  { value: "blitz", label: "Blitz" },
  { value: "rapid", label: "Rapid" }
];

/** Colour (in the URL), window, time class and recency weighting for the Explorer. */
export function FilterBar({
  color,
  onColorChange,
  filters,
  onFiltersChange
}: {
  color: PlayerColor;
  onColorChange: (color: PlayerColor) => void;
  filters: ExplorerFilters;
  onFiltersChange: (change: Partial<ExplorerFilters>) => void;
}) {
  // The 3-month view is never weighted (a 60-90 day half-life inside 90 days would discount twice).
  const canWeight = filters.window === "6m";

  return (
    <section className="panel filter-bar" aria-label="Explorer filters">
      <Segmented label="Colour" options={colorOptions} value={color} onChange={onColorChange} />
      <Segmented label="Window" options={windowOptions} value={filters.window} onChange={(window) => onFiltersChange({ window })} />
      <Segmented
        label="Time class"
        options={timeClassOptions}
        value={filters.timeClass}
        onChange={(timeClass) => onFiltersChange({ timeClass })}
      />
      <label
        className={`filter-check${canWeight ? "" : " filter-check-disabled"}`}
        title={
          canWeight
            ? "Weights each game by 0.5^(age / 90 days), so recent games count more. Raw counts are always shown."
            : "The 3-month view is unweighted."
        }
      >
        <input
          type="checkbox"
          checked={canWeight && filters.weighted}
          disabled={!canWeight}
          onChange={(event) => onFiltersChange({ weighted: event.target.checked })}
        />
        <span>Recent games count more</span>
      </label>
    </section>
  );
}
