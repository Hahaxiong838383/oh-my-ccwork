export type SetupStep = 'add' | 'login' | 'permissions' | 'bluetooth' | 'location' | 'found' | 'wifi' | 'connecting' | 'failure';

export function nextSkippedStep(step: SetupStep): SetupStep {
  switch (step) {
    case 'add': return 'login';
    case 'login': return 'permissions';
    case 'permissions': return 'bluetooth';
    case 'bluetooth': return 'location';
    case 'location': return 'found';
    default: return step;
  }
}
