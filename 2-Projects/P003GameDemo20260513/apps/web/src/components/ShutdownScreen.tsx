interface ShutdownScreenProps {}

export function ShutdownScreen(_props: ShutdownScreenProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-black text-white">
      <div className="text-center">
        <p className="text-lg font-semibold tracking-wide text-white/85">小可去夜航了</p>
        <p className="mt-2 text-xs text-white/45">按电源键唤醒</p>
      </div>
    </div>
  );
}
