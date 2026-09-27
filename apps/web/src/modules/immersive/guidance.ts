import type {
  AvailableWorldAction,
  SessionView,
  WorldSessionView,
} from '@vsm/shared';

export function selectedAction(
  world: WorldSessionView | undefined,
  selectedId: string | null,
) {
  return (
    world?.actions.find((action) => action.id === selectedId) ??
    world?.actions.find(
      (action) => action.available || action.reason === 'Подойдите к цели',
    ) ??
    world?.actions[0] ??
    null
  );
}

export function actionTarget(
  world: WorldSessionView,
  action: AvailableWorldAction | null,
) {
  const id =
    action?.command === 'move_actor'
      ? (world.actorAnchorId ?? world.scene.passenger.anchorId)
      : (action?.targetId ??
        world.actorAnchorId ??
        world.scene.passenger.anchorId);
  return world.scene.anchors.find((anchor) => anchor.id === id) ?? null;
}

export function scenarioDecisions(view: SessionView) {
  return view.history.filter(
    (item) => item.scenarioId === view.currentScenarioId,
  );
}

export function situationMessage(view: SessionView) {
  const decision = scenarioDecisions(view).at(-1);
  const reply = view.world?.dialogue?.messages
    .filter((item) => item.role === 'passenger')
    .at(-1);
  if (reply && (!decision || Date.parse(reply.at) > Date.parse(decision.at)))
    return { label: view.world?.scene.passenger.name, text: reply.text };
  if (decision)
    return {
      label: 'Ситуация сейчас',
      text: view.currentSituation?.text ?? decision.explanation,
    };
  return {
    label: view.world?.scene.passenger.name,
    text: view.world?.scene.passenger.initialLine,
  };
}
