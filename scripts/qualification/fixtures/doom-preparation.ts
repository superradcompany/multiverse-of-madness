interface Input {
  state: { x: number; y: number; z: number; angle: number; health: number };
  history: unknown[];
  experience: Array<{ result: { died: boolean; health: number; moved: number } }>;
  experienceLimit: number;
  planTicks?: number;
  feedback: { movement: { playerClearance: Record<'ahead' | 'left' | 'right' | 'behind', number> } };
}
/** Diagnostic source: creates its own local waypoints and retrieves adverse memories. Not a learned policy. */
export default function prepare(input: Input) {
  const angles = { ahead: 0, left: 90, right: -90, behind: 180 };
  const openings = Object.entries(angles).map(([name, offset]) => ({ offset, clearance: input.feedback.movement.playerClearance[name as keyof typeof angles] })).sort((a, b) => b.clearance - a.clearance);
  const experienceIndices = input.experience.map((item, index) => ({ index, weight: Number(item.result.died) * 1000 - item.result.health + Number(item.result.moved < 8) * 10 }))
    .sort((a, b) => b.weight - a.weight || b.index - a.index).slice(0, input.experienceLimit).map(item => item.index);
  return {
    abi: 'doom-preparation/1', historyIndices: input.history.map((_, index) => index), experienceIndices,
    features: { healthPressure: input.state.health < 50, widestObservedClearance: openings[0]!.clearance },
    ...(input.planTicks ? { plans: openings.slice(0, 2).map((opening, index) => {
      const distance = Math.max(24, Math.min(96, opening.clearance - 16)), radians = (input.state.angle + opening.offset) * Math.PI / 180;
      return { id: 'learning_route_' + index, label: 'Try measured opening ' + (index + 1), family: 'exploration', steps: [{
        kind: 'move', label: 'Follow the generated waypoint', maxTicks: Math.min(35, input.planTicks!), within: 12,
        target: { kind: 'point', x: input.state.x + Math.cos(radians) * distance, y: input.state.y + Math.sin(radians) * distance, z: input.state.z },
      }] };
    }) } : {}),
  };
}
