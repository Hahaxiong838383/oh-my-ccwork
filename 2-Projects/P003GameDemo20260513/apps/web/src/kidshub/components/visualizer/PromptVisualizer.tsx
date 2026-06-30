// 临时 stub —— Lane B 外包 agent 会覆盖为真实实现。
// 保留此 stub 是为了让 PromptPanel 集成提交后 tsc 不挂；外包完成后这里会被整个换掉。
export function PromptVisualizer() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-xs text-neutral-500">
      🚧 拼接可视化组件构建中…（Lane B 外包未到岗）
    </div>
  );
}
