import { useId, useState } from "react";

export interface DayBar {
  /** "YYYY-MM-DD". */
  day: string;
  value: number;
  /** Extra tooltip text, e.g. "8 on the first try". */
  detail?: string;
}

export interface DayBarsProps {
  title: string;
  /** What one unit is, for the tooltip and the table: "position" → "3 positions". */
  unit: string;
  bars: readonly DayBar[];
  /** Label for bars[0] when it is today ("Today" or "Due now"). */
  firstLabel?: string;
}

const dayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

function label(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return dayFormat.format(new Date(year, month - 1, date, 12));
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * A single-series column chart by day: thin columns from one baseline, the value on hover or
 * focus, and a table view for screen readers and exact numbers.
 */
export function DayBars({ title, unit, bars, firstLabel }: DayBarsProps) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  const top = niceCeil(max);
  const nameOf = (index: number) => (index === 0 && firstLabel ? firstLabel : label(bars[index].day));

  return (
    <figure className="day-bars" aria-labelledby={`${id}-title`}>
      <figcaption className="row-between">
        <span id={`${id}-title`} className="day-bars-title">
          {title}
        </span>
        <button type="button" className="text-button small" onClick={() => setShowTable((value) => !value)} aria-expanded={showTable}>
          {showTable ? "Show chart" : "Show as table"}
        </button>
      </figcaption>
      {showTable ? (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{unit[0].toUpperCase() + unit.slice(1)}s</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((bar, index) => (
              <tr key={bar.day}>
                <td>{nameOf(index)}</td>
                <td className="tabular">
                  {bar.value}
                  {bar.detail ? <span className="muted"> · {bar.detail}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="day-bars-plot">
          <span className="day-bars-tick day-bars-tick-top tabular" aria-hidden="true">
            {top}
          </span>
          <span className="day-bars-tick day-bars-tick-zero tabular" aria-hidden="true">
            0
          </span>
          <div className="day-bars-columns" role="list" aria-label={title} onMouseLeave={() => setActive(null)}>
            {bars.map((bar, index) => {
              const name = `${nameOf(index)}: ${plural(bar.value, unit)}${bar.detail ? `, ${bar.detail}` : ""}`;
              return (
                <div
                  key={bar.day}
                  className={`day-bars-slot${active === index ? " is-active" : ""}`}
                  role="listitem"
                  tabIndex={0}
                  aria-label={name}
                  onMouseEnter={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive((current) => (current === index ? null : current))}
                >
                  <span className="day-bars-bar" style={{ height: `${(bar.value / top) * 100}%` }} />
                  {active === index ? (
                    <span className="day-bars-tip" role="tooltip">
                      <strong>{nameOf(index)}</strong>
                      <span className="tabular">{plural(bar.value, unit)}</span>
                      {bar.detail ? <span className="muted">{bar.detail}</span> : null}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="day-bars-axis" aria-hidden="true">
            <span>{nameOf(0)}</span>
            <span>{label(bars[bars.length - 1].day)}</span>
          </div>
        </div>
      )}
    </figure>
  );
}

/** A clean round maximum for the axis: 1, 2, 5, 10, 20, 50… */
function niceCeil(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * power) {
      return step * power;
    }
  }
  return 10 * power;
}
