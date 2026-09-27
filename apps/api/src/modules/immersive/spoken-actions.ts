import { available, availableWorld, type GameState } from '../../engine.js';
import { actionReason, activeScene, distance } from './world.js';

export function spokenChoices(state: GameState) {
  return [
    ...availableWorld(state).map((a) => ({
      id: a.id,
      text: a.text,
      description: a.improvement,
      kind: 'world' as const,
    })),
    ...available(state).map((a) => ({
      ...a,
      description: a.text,
      kind: 'answer' as const,
    })),
  ];
}
const normalize = (text: string) =>
  text
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export function exactSpokenAction(
  state: GameState,
  text: string,
): string | undefined {
  if (text.includes("?")) return undefined;
  const value = normalize(text);
  const command = value.replace(
    /^(?:выполнить|выполни|действие|выбираю)\s+/,
    '',
  );
  const matches = spokenChoices(state).filter(
    (a) => normalize(a.text) === value || normalize(a.text) === command,
  );
  return matches.length === 1 ? matches[0].id : undefined;
}
export function resolveSpokenAction(state: GameState, actionId: string) {
  const scene = activeScene(state),
    world = state.world;
  const choice = spokenChoices(state).find((a) => a.id === actionId);
  if (!choice || !scene || !world)
    return {
      reason: 'Эта команда сейчас недоступна. Выберите действие текущего шага.',
    };
  if (choice.kind === 'world') {
    const action = availableWorld(state).find((a) => a.id === actionId)!;
    const reason = actionReason(scene, world, action);
    const target = scene.anchors.find(
      (a) =>
        a.id ===
        (action.command === 'move_actor'
          ? world.actorAnchorId
          : action.targetId),
    );
    return reason
      ? {
          reason: `${choice.text}: ${reason.toLowerCase()}${target ? ` — ${target.label}` : ''}.`,
          choice,
        }
      : { action: { worldActionId: actionId }, choice };
  }
  const actor = scene.anchors.find((a) => a.id === world.actorAnchorId);
  if (!actor || distance(world.position, actor) > actor.radius)
    return {
      reason: 'Подойдите к пассажиру, чтобы подтвердить решение.',
      choice,
    };
  return { action: { answerId: actionId }, choice };
}
