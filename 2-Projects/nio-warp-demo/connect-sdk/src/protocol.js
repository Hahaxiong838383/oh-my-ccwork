// Client extension point: declare new input messages here and update the protocol document/tests.
// This module accepts no geometry, Warp configuration or system shortcut commands.
export function isCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      Object.keys(command).length !== 2 || !Object.hasOwn(command, 'messageId') ||
      !Object.hasOwn(command, 'value')) return false;
  switch (command.messageId) {
    case 'demo.level': return typeof command.value === 'number' && Number.isFinite(command.value) &&
      command.value >= 0 && command.value <= 100;
    case 'demo.toggle': return command.value === 0 || command.value === 1;
    case 'demo.action': return ['next', 'reset'].includes(command.value);
    default: return false;
  }
}
