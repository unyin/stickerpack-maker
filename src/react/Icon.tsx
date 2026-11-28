import { PATHS, type IconName } from "../icons";

/**
 * React twin of `icon()` (icons.ts): the same svg, attribute order and paths,
 * so the markup is byte-identical.
 */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className={`icon icon-${name}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
