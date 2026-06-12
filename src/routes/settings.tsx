import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, RotateCcw, Settings as SettingsIcon } from "lucide-react";
import {
  DEFAULT_READER_SETTINGS,
  READER_SETTINGS_LIMITS,
  resetReaderSettings,
  saveReaderSettings,
  useReaderSettings,
} from "@/lib/reader-settings";

export const Route = createFileRoute("/settings")({
  component: SettingsComponent,
});

interface SliderRowProps {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

function SliderRow({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
}: SliderRowProps) {
  return (
    <div className="py-4 border-b border-ink/10 last:border-b-0">
      <div className="flex items-center justify-between gap-4">
        <label className="text-sm font-medium text-ink" htmlFor={`set-${label}`}>
          {label}
        </label>
        <span className="text-sm font-semibold text-accent tabular-nums shrink-0">
          {format ? format(value) : value}
        </span>
      </div>
      <p className="text-xs text-ink-tertiary mt-1 mb-3 max-w-xl">{description}</p>
      <input
        id={`set-${label}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent cursor-pointer"
      />
      <div className="flex justify-between text-[10px] text-ink-tertiary tabular-nums mt-1">
        <span>{format ? format(min) : min}</span>
        <span>{format ? format(max) : max}</span>
      </div>
    </div>
  );
}

function SettingsComponent() {
  const settings = useReaderSettings();

  return (
    <div className="min-h-screen bg-parchment paper-texture">
      <main className="max-w-2xl mx-auto px-4 sm:px-6 pt-6 sm:pt-10 pb-16">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            to="/"
            className="p-2 -ml-2 rounded-lg text-ink-muted hover:text-ink hover:bg-ink/5 transition-colors"
            aria-label="Back to library"
          >
            <ArrowLeft className="h-5 w-5" strokeWidth={1.5} />
          </Link>
          <div className="w-8 h-8 bg-ink rounded-lg flex items-center justify-center">
            <SettingsIcon className="h-4 w-4 text-white" strokeWidth={1.5} />
          </div>
          <h1 className="text-xl sm:text-2xl font-semibold text-ink tracking-tight">Settings</h1>
        </div>

        {/* Reader memory section */}
        <section className="bg-white border border-ink rounded-lg shadow-sm p-4 sm:p-6">
          <div className="mb-2">
            <h2 className="text-base font-semibold text-ink">Reader performance</h2>
            <p className="text-xs text-ink-tertiary mt-1 max-w-xl">
              Lower values use less memory — helpful if the reader crashes with “A problem repeatedly
              occurred” (common in Safari on large PDFs or image-heavy comics). Higher values page
              faster but keep more in memory. Changes apply the next time a page loads.
            </p>
          </div>

          <SliderRow
            label="Pages prefetched ahead"
            description="How many upcoming pages to decode in the background so the next page appears instantly. The single biggest memory lever for PDFs and comics."
            value={settings.prefetchAhead}
            min={READER_SETTINGS_LIMITS.prefetchAhead.min}
            max={READER_SETTINGS_LIMITS.prefetchAhead.max}
            onChange={(prefetchAhead) => saveReaderSettings({ ...settings, prefetchAhead })}
          />

          <SliderRow
            label="Pages prefetched behind"
            description="How many previous pages to keep warm for fast back-paging."
            value={settings.prefetchBehind}
            min={READER_SETTINGS_LIMITS.prefetchBehind.min}
            max={READER_SETTINGS_LIMITS.prefetchBehind.max}
            onChange={(prefetchBehind) => saveReaderSettings({ ...settings, prefetchBehind })}
          />

          <SliderRow
            label="Max PDF render scale"
            description="Caps the pixel density used to rasterize PDF pages. Retina screens report 2–3×; capping at 2× roughly halves canvas memory with little visible difference. Raise for sharper text, lower if PDFs crash."
            value={settings.maxRenderScale}
            min={READER_SETTINGS_LIMITS.maxRenderScale.min}
            max={READER_SETTINGS_LIMITS.maxRenderScale.max}
            step={0.5}
            format={(v) => `${v}×`}
            onChange={(maxRenderScale) => saveReaderSettings({ ...settings, maxRenderScale })}
          />

          {/* Default load mode */}
          <div className="py-4">
            <div className="flex items-center justify-between gap-4 mb-1">
              <span className="text-sm font-medium text-ink">Default load mode</span>
            </div>
            <p className="text-xs text-ink-tertiary mb-3 max-w-xl">
              <strong>Stream</strong> fetches pages on demand (less memory, best for big files).{" "}
              <strong>Full</strong> downloads the whole file up front (smoother once loaded).
            </p>
            <div className="inline-flex items-center border border-ink rounded-lg overflow-hidden">
              {(["stream", "full"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => saveReaderSettings({ ...settings, defaultLoadMode: mode })}
                  aria-pressed={settings.defaultLoadMode === mode}
                  className={`px-4 py-1.5 text-sm capitalize transition-colors ${
                    settings.defaultLoadMode === mode
                      ? "bg-ink text-white"
                      : "bg-white text-ink-muted hover:text-ink"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Reset */}
          <div className="pt-4 mt-2 border-t border-ink/10 flex items-center justify-between gap-4">
            <span className="text-xs text-ink-tertiary">
              Defaults: {DEFAULT_READER_SETTINGS.prefetchAhead} ahead /{" "}
              {DEFAULT_READER_SETTINGS.prefetchBehind} behind, {DEFAULT_READER_SETTINGS.maxRenderScale}×
            </span>
            <button
              type="button"
              onClick={() => resetReaderSettings()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink px-3 py-1.5 text-sm text-ink-muted hover:text-ink hover:bg-ink/5 transition-colors shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
              Reset
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
