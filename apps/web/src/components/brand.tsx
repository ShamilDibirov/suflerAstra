export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      {!compact && (
        <span>
          суфлёр<span className="brand-dot">.</span>
        </span>
      )}
    </div>
  );
}
