import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import type {
  Connection,
  NodeProps,
  Node as FlowNode,
  NodeChange,
  Edge as FlowEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  Folder,
  GitBranch,
  Link2,
  LoaderCircle,
  LocateFixed,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  GraphEdge,
  GraphNode,
  ScenarioDefinition,
  ScenarioRecord,
  ScenarioSummary,
  ValidationIssue,
  ValidationResult,
} from '@vsm/shared';
import { api, ApiError } from '../../lib/api';
import { ConnectPanel, EdgePanel, MetadataPanel, NodePanel, ScenePanel } from './Panels';
import type { ImmersiveCatalog } from './Panels';
import {
  addChild,
  canvasEdgeLabel,
  clone,
  duplicateSelected,
  edgeSummary,
  kindName,
  newNode,
  nodeName,
  preflight,
  rehomeImportedDefinition,
  removeSelected,
  removeChild,
  template,
  uid,
} from './model';
import './editor.css';
import { AssistantPanel } from './AssistantPanel';

type Picked = { type: 'node' | 'edge'; id: string };
type MobileTab = 'list' | 'graph' | 'parameters';
type EditorFlowNode = FlowNode<{ item: GraphNode; start: boolean }>;

const GraphCard = memo(
  function GraphCard({ data, selected }: NodeProps) {
    const { item, start } = data as EditorFlowNode['data'];
    return (
      <div
        className={`ed-graph-node ed-graph-node-${item.type}${selected ? ' ed-graph-node-selected' : ''}`}
      >
        <Handle type="target" position={Position.Left} className="ed-handle" />
        <div className="ed-graph-node-top">
          <span>{kindName(item.type)}</span>
          {start && <strong>СТАРТ</strong>}
        </div>
        <b>{item.title || 'Без названия'}</b>
        {item.type === 'scenario' ? (
          <small>
            {item.scenarioId ? item.scenarioId.slice(0, 12) : 'Выберите вложенный сценарий'}
          </small>
        ) : item.type === 'end' ? (
          <small>Исход: {item.outcome || 'не задан'}</small>
        ) : (
          <small>{item.text || 'Добавьте текст в параметрах'}</small>
        )}
        <Handle type="source" position={Position.Right} className="ed-handle" />
      </div>
    );
  },
  (before, after) => {
    const left = before.data as EditorFlowNode['data'];
    const right = after.data as EditorFlowNode['data'];
    return (
      before.selected === after.selected &&
      left.start === right.start &&
      left.item.type === right.item.type &&
      left.item.title === right.item.title &&
      (left.item.type === 'scenario'
        ? left.item.scenarioId === (right.item as typeof left.item).scenarioId
        : left.item.type === 'end'
          ? left.item.outcome === (right.item as typeof left.item).outcome &&
            left.item.text === (right.item as typeof left.item).text
          : left.item.text === (right.item as typeof left.item).text)
    );
  },
);
const nodeTypes = { graph: GraphCard };
const edgeMarker = { type: 'arrowclosed' as const };
const edgeStyle = { strokeWidth: 2 };
const edgeLabelStyle = { fontSize: 12, fontWeight: 600 };
const initialViewport = { x: 80, y: 80, zoom: 0.95 };

const GraphOutline = memo(
  function GraphOutline({
    nodes,
    edges,
    startNodeId,
    selectedNodeIds,
    selectedEdgeIds,
    onPick,
  }: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    startNodeId: string;
    selectedNodeIds: Set<string>;
    selectedEdgeIds: Set<string>;
    onPick: (item: Picked) => void;
  }) {
    return (
      <div className="ed-node-list">
        <h3>Элементы дерева</h3>
        {nodes.map((node) => (
          <button
            type="button"
            key={node.id}
            aria-pressed={selectedNodeIds.has(node.id)}
            onClick={() => onPick({ type: 'node', id: node.id })}
          >
            <span>
              {kindName(node.type)} · {nodeName(node)}
            </span>
            {startNodeId === node.id && <strong>Старт</strong>}
          </button>
        ))}
        {edges.length > 0 && (
          <>
            <h3>Переходы</h3>
            {edges.map((edge) => (
              <button
                type="button"
                key={edge.id}
                aria-pressed={selectedEdgeIds.has(edge.id)}
                onClick={() => onPick({ type: 'edge', id: edge.id })}
              >
                {edgeSummary(edge)}
              </button>
            ))}
          </>
        )}
      </div>
    );
  },
  (before, after) =>
    before.startNodeId === after.startNodeId &&
    before.onPick === after.onPick &&
    before.edges === after.edges &&
    before.selectedNodeIds === after.selectedNodeIds &&
    before.selectedEdgeIds === after.selectedEdgeIds &&
    before.nodes.length === after.nodes.length &&
    before.nodes.every(
      (node, index) =>
        node.id === after.nodes[index].id &&
        node.title === after.nodes[index].title &&
        node.type === after.nodes[index].type,
    ),
);

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Сеанс завершён. Войдите снова, чтобы продолжить работу.';
    if (error.status === 403) return error.message;
    if (error.status === 503)
      return 'Редактор сейчас отключён администратором. Черновики сохраняются на сервере.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос. Повторите попытку.';
}

function downloadJson(def: ScenarioDefinition) {
  const blob = new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${def.title.trim().replace(/[^\p{L}\p{N}-]+/gu, '-') || 'scenario'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function EditorPageContent() {
  const { fitView, setCenter } = useReactFlow();
  const [list, setList] = useState<ScenarioSummary[]>([]);
  const [catalog, setCatalog] = useState<ImmersiveCatalog | null>(null);
  const [record, setRecord] = useState<ScenarioRecord | null>(null);
  const [def, setDef] = useState<ScenarioDefinition | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [multiPickMode, setMultiPickMode] = useState(false);
  const [query, setQuery] = useState('');
  const [childChoice, setChildChoice] = useState('');
  const [mobileTab, setMobileTab] = useState<MobileTab>('list');
  const [showHierarchy, setShowHierarchy] = useState(true);
  const [showParameters, setShowParameters] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'validate' | 'publish' | 'create' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [conflict, setConflict] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);
  const [collapsedMegaId, setCollapsedMegaId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const savedDefRef = useRef<ScenarioDefinition | null>(null);
  const dirty = !!def && def !== savedDefRef.current;
  const ordinary = useMemo(() => list.filter((s) => s.kind === 'scenario'), [list]);
  useEffect(() => {
    let active = true;
    void api
      .get<ImmersiveCatalog>('/immersive/catalog')
      .then((value) => {
        if (
          active &&
          Array.isArray(value.trainClasses) &&
          Array.isArray(value.anchorKinds) &&
          Array.isArray(value.itemPrefabs) &&
          Array.isArray(value.commands)
        )
          setCatalog(value);
      })
      .catch(() => {
        if (active) setCatalog(null);
      });
    return () => {
      active = false;
    };
  }, []);

  // Opening a different document starts near its first branch. Form edits keep the user's viewport.
  useEffect(() => {
    if (!record || !def?.nodes.length) return;
    const start = def.nodes.find((node) => node.id === def.startNodeId) ?? def.nodes[0];
    const frame = requestAnimationFrame(() => {
      void setCenter(start.position.x + (def.kind === 'mega' ? 270 : 360), start.position.y + 220, {
        zoom: 0.95,
      });
    });
    return () => cancelAnimationFrame(frame);
    // The viewport changes only when the document changes, not when its form fields change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.summary.id]);

  const loadList = useCallback(async () => {
    const summaries = await api.get<ScenarioSummary[]>('/editor/scenarios');
    setList(summaries);
    return summaries;
  }, []);
  const open = useCallback(
    async (id: string, force = false) => {
      if (
        !force &&
        dirty &&
        !window.confirm('Есть несохранённые изменения. Открыть другой сценарий и потерять их?')
      )
        return false;
      setLoading(true);
      setError('');
      setNotice('');
      setIssues([]);
      setConflict(false);
      try {
        const next = await api.get<ScenarioRecord>(`/editor/scenarios/${id}`);
        setRecord(next);
        setDef(next.definition);
        savedDefRef.current = next.definition;
        setPicked([]);
        history.replaceState(null, '', `${location.pathname}?scenario=${encodeURIComponent(id)}`);
        setMobileTab('graph');
        return true;
      } catch (e) {
        setError(errorText(e));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [dirty],
  );

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const summaries = await api.get<ScenarioSummary[]>('/editor/scenarios');
        if (!live) return;
        setList(summaries);
        const id = new URLSearchParams(location.search).get('scenario');
        if (id && summaries.some((s) => s.id === id)) {
          const next = await api.get<ScenarioRecord>(`/editor/scenarios/${id}`);
          if (live) {
            setRecord(next);
            setDef(next.definition);
            savedDefRef.current = next.definition;
            setMobileTab('graph');
          }
        }
      } catch (e) {
        if (live) setError(errorText(e));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const protectLinks = (event: MouseEvent) => {
      const target = event.target;
      const anchor = target instanceof Element ? target.closest('a[href]') : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.origin !== location.origin ||
        anchor.pathname === location.pathname ||
        window.confirm('Есть несохранённые изменения. Покинуть редактор и потерять их?')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('click', protectLinks, true);
    return () => document.removeEventListener('click', protectLinks, true);
  }, [dirty]);
  useEffect(() => {
    const handler = (e: PopStateEvent) => {
      const id = new URLSearchParams(location.search).get('scenario');
      if (id && id !== record?.summary.id) {
        if (dirty) {
          if (!window.confirm('Есть несохранённые изменения. Открыть другой сценарий?')) {
            history.pushState(null, '', `?scenario=${record?.summary.id ?? ''}`);
            return;
          }
        }
        void open(id, true);
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [record?.summary.id, dirty, open]);

  const edit = (next: ScenarioDefinition) => {
    setDef(next);
    setNotice('');
    setIssues([]);
  };
  const create = async (kind: ScenarioDefinition['kind'], immersive = false) => {
    if (
      dirty &&
      !window.confirm('Есть несохранённые изменения. Создать новый сценарий и потерять их?')
    )
      return;
    const title =
      kind === 'mega' ? 'Новый маршрут' : immersive ? 'Новый 3D-сценарий' : 'Новый сценарий';
    setBusy('create');
    setError('');
    try {
      const next = await api.post<ScenarioRecord>('/editor/scenarios', { title, kind });
      setRecord(next);
      const draft = template(next.summary.id, title, kind, immersive);
      setDef(draft);
      savedDefRef.current = next.definition;
      setPicked([]);
      setParentId(null);
      setMobileTab('graph');
      setNotice('Черновик создан. Настройте граф и сохраните изменения.');
      history.replaceState(
        null,
        '',
        `${location.pathname}?scenario=${encodeURIComponent(next.summary.id)}`,
      );
      try {
        await loadList();
      } catch {
        setError('Сценарий создан, но список пока не обновился. Повторите загрузку списка позже.');
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const saveDraft = async (): Promise<ScenarioRecord | null> => {
    if (!record || !def) return null;
    const submitted = def;
    setBusy('save');
    setError('');
    setNotice('');
    setConflict(false);
    try {
      const saved = await api.put<ScenarioRecord>(`/editor/scenarios/${record.summary.id}`, {
        definition: def,
        expectedRevision: record.revision,
      });
      setRecord(saved);
      savedDefRef.current = saved.definition;
      setDef((current) => (current && current !== submitted ? current : saved.definition));
      setNotice('Черновик сохранён на сервере.');
      try {
        await loadList();
      } catch {
        setError('Черновик сохранён, но список пока не обновился.');
      }
      return saved;
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      return null;
    } finally {
      setBusy(null);
    }
  };
  const validate = async () => {
    if (!record || !def) return;
    setBusy('validate');
    setError('');
    setNotice('');
    const local = preflight(def);
    try {
      const result = await api.post<ValidationResult>(
        `/editor/scenarios/${record.summary.id}/validate`,
        { definition: def },
      );
      setIssues(result.issues.length ? result.issues : local);
      setNotice(
        result.valid
          ? 'Сервер подтвердил: граф готов к публикации.'
          : `Сервер нашёл ${result.issues.length} проблем. Исправьте их перед публикацией.`,
      );
    } catch (e) {
      setIssues(local);
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const publish = async () => {
    if (!record || !def) return;
    setError('');
    setNotice('');
    setBusy('publish');
    try {
      let current = record;
      if (dirty) {
        current = await api.put<ScenarioRecord>(`/editor/scenarios/${record.summary.id}`, {
          definition: def,
          expectedRevision: record.revision,
        });
        setRecord(current);
        setDef(current.definition);
        savedDefRef.current = current.definition;
      }
      const published = await api.post<ScenarioRecord>(
        `/editor/scenarios/${record.summary.id}/publish`,
        { expectedRevision: current.revision },
      );
      setRecord(published);
      setDef(published.definition);
      savedDefRef.current = published.definition;
      setIssues([]);
      setNotice(
        `Версия ${published.publishedVersion} опубликована. Уже начатые прохождения сохраняют прежнюю версию.`,
      );
      try {
        await loadList();
      } catch {
        setError('Версия опубликована, но список пока не обновился.');
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      if (e instanceof ApiError && e.status === 422) {
        const details = e.details as ValidationResult | undefined;
        if (details?.issues) setIssues(details.issues);
      }
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const addNode = (type: GraphNode['type']) => {
    if (!def) return;
    const sameType = def.nodes.filter((n) => n.type === type);
    const scenarioCount = def.nodes.filter((n) => n.type === 'scenario').length;
    const position =
      def.kind === 'mega'
        ? {
            x:
              30 +
              (type === 'end' ? Math.ceil(scenarioCount / 2) : 0) * 300 +
              Math.floor(sameType.length / 2) * 300,
            y: 90 + (sameType.length % 2) * 230,
          }
        : {
            x: type === 'situation' ? 30 : type === 'answer' ? 300 : 570,
            y: sameType.length ? Math.max(...sameType.map((n) => n.position.y)) + 240 : 80,
          };
    const node = newNode(type, position);
    if (node.type === 'worldAction' && def.scene) {
      node.command = catalog?.commands[0] ?? node.command;
      node.targetId = def.scene.anchors[0]?.id ?? '';
    }
    edit({ ...def, nodes: [...def.nodes, node], startNodeId: def.startNodeId || node.id });
    setPicked([{ type: 'node', id: node.id }]);
    setMobileTab('parameters');
  };
  const connect = (source: string, target: string) => {
    if (!def || !source || !target || source === target) {
      setError('Для связи выберите два разных узла.');
      return;
    }
    const edge: GraphEdge = {
      id: uid(),
      source,
      target,
      trigger: 'default',
      priority: def.edges.filter((e) => e.source === source).length + 1,
    };
    edit({ ...def, edges: [...def.edges, edge] });
    setPicked([{ type: 'edge', id: edge.id }]);
    setMobileTab('parameters');
    setError('');
  };
  const connectRef = useRef(connect);
  connectRef.current = connect;
  const onConnectFlow = useCallback((connection: Connection) => {
    connectRef.current(connection.source, connection.target);
  }, []);
  const onConnectForm = useCallback(
    (source: string, target: string) => connectRef.current(source, target),
    [],
  );
  const duplicateSelection = () => {
    if (!def || !picked.length || busy) return;
    const result = duplicateSelected(
      def,
      picked.filter((v) => v.type === 'node').map((v) => v.id),
    );
    if ('error' in result) {
      setNotice(result.error);
      return;
    }
    edit(result.definition);
    setPicked([
      ...result.nodeIds.map((id): Picked => ({ type: 'node', id })),
      ...result.edgeIds.map((id): Picked => ({ type: 'edge', id })),
    ]);
    setNotice(
      `Скопировано ${result.nodeIds.length} узлов и ${result.edgeIds.length} внутренних связей. Сохраните черновик.`,
    );
  };
  const deleteSelection = () => {
    if (!def || !picked.length || busy) return;
    const nodeIds = picked.filter((v) => v.type === 'node').map((v) => v.id);
    const edgeIds = picked.filter((v) => v.type === 'edge').map((v) => v.id);
    const incident = def.edges.filter(
      (edge) => nodeIds.includes(edge.source) || nodeIds.includes(edge.target),
    );
    const start = nodeIds.includes(def.startNodeId);
    const prompt =
      `Удалить ${nodeIds.length} узлов и ${new Set([...edgeIds, ...incident.map((e) => e.id)]).size} связей?` +
      (start ? ' Стартовый узел будет удалён; назначьте новый перед публикацией.' : '');
    if (!window.confirm(prompt)) return;
    edit(removeSelected(def, nodeIds, edgeIds));
    setPicked([]);
    setNotice(
      start
        ? 'Стартовый узел удалён. Назначьте новый старт и проверьте граф.'
        : 'Выбранные элементы удалены.',
    );
  };
  const keyActionRef = useRef({
    duplicateSelection,
    deleteSelection,
    active: !!def && picked.length > 0,
  });
  keyActionRef.current = {
    duplicateSelection,
    deleteSelection,
    active: !!def && picked.length > 0 && !busy,
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const focused = document.activeElement;
      if (
        !(target instanceof Element) ||
        !target.closest('.ed-root') ||
        !(focused instanceof Element) ||
        !focused.closest('.ed-root')
      )
        return;
      if (target.closest('input, textarea, select, [contenteditable], [role="textbox"]')) return;
      if (!keyActionRef.current.active || event.repeat) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'd'
      ) {
        event.preventDefault();
        keyActionRef.current.duplicateSelection();
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Delete') {
        event.preventDefault();
        keyActionRef.current.deleteSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const onNodesChange = useCallback((changes: NodeChange<EditorFlowNode>[]) => {
    const positions = new Map(
      changes.flatMap((change) =>
        change.type === 'position' && change.position
          ? [[change.id, change.position] as const]
          : [],
      ),
    );
    if (!positions.size) return;
    setDef((current) => {
      if (!current) return current;
      let changed = false;
      const nodes = current.nodes.map((node) => {
        const position = positions.get(node.id);
        if (!position || (position.x === node.position.x && position.y === node.position.y))
          return node;
        changed = true;
        return { ...node, position };
      });
      return changed ? { ...current, nodes } : current;
    });
    setNotice('');
    setIssues([]);
  }, []);
  const pick = useCallback((item: Picked, additive: boolean) => {
    setPicked((current) => {
      if (!additive)
        return current.length === 1 && current[0].type === item.type && current[0].id === item.id
          ? current
          : [item];
      const exists = current.some((value) => value.type === item.type && value.id === item.id);
      return exists
        ? current.filter((value) => value.type !== item.type || value.id !== item.id)
        : [...current, item];
    });
  }, []);
  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: EditorFlowNode) => {
      canvasRef.current?.focus({ preventScroll: true });
      pick({ type: 'node', id: node.id }, event.shiftKey || multiPickMode);
    },
    [pick, multiPickMode],
  );
  const onEdgeClick = useCallback(
    (event: React.MouseEvent, edge: FlowEdge) => {
      canvasRef.current?.focus({ preventScroll: true });
      pick({ type: 'edge', id: edge.id }, event.shiftKey || multiPickMode);
      if (!multiPickMode && !event.shiftKey) setMobileTab('parameters');
    },
    [pick, multiPickMode],
  );
  const onPaneClick = useCallback(() => {
    canvasRef.current?.focus({ preventScroll: true });
    setPicked([]);
  }, []);
  const onOutlinePick = useCallback(
    (item: Picked) => {
      pick(item, multiPickMode);
      if (!multiPickMode) setMobileTab('parameters');
    },
    [pick, multiPickMode],
  );
  const single = picked.length === 1 ? picked[0] : null;
  const selectedNode =
    single?.type === 'node' ? def?.nodes.find((n) => n.id === single.id) : undefined;
  const selectedEdge =
    single?.type === 'edge' ? def?.edges.find((e) => e.id === single.id) : undefined;
  const selectedNodeIds = useMemo(
    () => new Set(picked.filter((v) => v.type === 'node').map((v) => v.id)),
    [picked],
  );
  const selectedEdgeIds = useMemo(
    () => new Set(picked.filter((v) => v.type === 'edge').map((v) => v.id)),
    [picked],
  );
  const nodeCache = useRef(new Map<string, EditorFlowNode>());
  const nodes = useMemo<EditorFlowNode[]>(() => {
    const next = (def?.nodes ?? []).map((item) => {
      const selected = selectedNodeIds.has(item.id);
      const start = def?.startNodeId === item.id;
      const previous = nodeCache.current.get(item.id);
      if (
        previous &&
        previous.data.item === item &&
        previous.data.start === start &&
        previous.selected === selected
      )
        return previous;
      const node: EditorFlowNode = {
        id: item.id,
        type: 'graph',
        position: item.position,
        selected,
        data: { item, start },
      };
      nodeCache.current.set(item.id, node);
      return node;
    });
    if (nodeCache.current.size > next.length)
      nodeCache.current = new Map(next.map((node) => [node.id, node]));
    return next;
  }, [def?.nodes, def?.startNodeId, selectedNodeIds]);
  const edgeCache = useRef(new Map<string, FlowEdge>());
  const edges = useMemo<FlowEdge[]>(() => {
    const next = (def?.edges ?? []).map((edge) => {
      const selected = selectedEdgeIds.has(edge.id);
      const previous = edgeCache.current.get(edge.id);
      if (previous && previous.data?.item === edge && previous.selected === selected)
        return previous;
      const flowEdge: FlowEdge = {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        label: def ? canvasEdgeLabel(edge, def) : '',
        selected,
        markerEnd: edgeMarker,
        style: edgeStyle,
        labelStyle: edgeLabelStyle,
        data: { item: edge },
      };
      edgeCache.current.set(edge.id, flowEdge);
      return flowEdge;
    });
    if (edgeCache.current.size > next.length)
      edgeCache.current = new Map(next.map((edge) => [edge.id, edge]));
    return next;
  }, [def?.edges, selectedEdgeIds]);
  const filtered = useMemo(
    () =>
      list.filter((s) =>
        `${s.title} ${s.description}`
          .toLocaleLowerCase('ru')
          .includes(query.toLocaleLowerCase('ru')),
      ),
    [list, query],
  );
  const megas = filtered.filter((s) => s.kind === 'mega');
  const standalones = filtered.filter((s) => s.kind === 'scenario');
  const parent = parentId ? list.find((s) => s.id === parentId) : null;

  const addMembership = async (scenarioId: string, megaId = record?.summary.id) => {
    if (!megaId) return;
    const child = ordinary.find((s) => s.id === scenarioId);
    if (!child) return;
    if (record?.summary.id === megaId && def?.kind === 'mega')
      edit(addChild(def, child.id, child.title));
    else {
      if (
        dirty &&
        !window.confirm('Есть несохранённые изменения. Открыть другой маршрут и потерять их?')
      )
        return;
      setLoading(true);
      setError('');
      try {
        const next = await api.get<ScenarioRecord>(`/editor/scenarios/${megaId}`);
        if (next.definition.kind !== 'mega')
          throw new Error('Выбранный элемент не является маршрутом.');
        setRecord(next);
        setDef(addChild(next.definition, child.id, child.title));
        savedDefRef.current = next.definition;
        setPicked([]);
        setParentId(null);
        setMobileTab('graph');
        history.replaceState(
          null,
          '',
          `${location.pathname}?scenario=${encodeURIComponent(megaId)}`,
        );
      } catch (e) {
        setError(errorText(e));
        return;
      } finally {
        setLoading(false);
      }
    }
    setChildChoice('');
    setNotice(
      `${child.title} добавлен в состав. Соедините узлы на поле, чтобы задать порядок прохождения.`,
    );
  };
  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as ScenarioDefinition;
      if (
        (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
        !['scenario', 'mega'].includes(parsed.kind) ||
        !Array.isArray(parsed.nodes) ||
        !Array.isArray(parsed.edges)
      )
        throw new Error('Файл не похож на определение сценария версии 1 или 2.');
      if (
        dirty &&
        !window.confirm('Есть несохранённые изменения. Импортировать файл и потерять их?')
      )
        return;
      setBusy('create');
      setError('');
      const created = await api.post<ScenarioRecord>('/editor/scenarios', {
        title: parsed.title || 'Импортированный сценарий',
        kind: parsed.kind,
      });
      const imported = rehomeImportedDefinition(parsed, created.summary.id);
      imported.title = parsed.title || created.summary.title;
      const saved = await api.put<ScenarioRecord>(`/editor/scenarios/${created.summary.id}`, {
        definition: imported,
        expectedRevision: created.revision,
      });
      setRecord(saved);
      setDef(saved.definition);
      savedDefRef.current = saved.definition;
      setPicked([]);
      setParentId(null);
      setMobileTab('graph');
      history.replaceState(
        null,
        '',
        `${location.pathname}?scenario=${encodeURIComponent(saved.summary.id)}`,
      );
      setNotice('Импортирован новый черновик. Проверьте его перед публикацией.');
      try {
        await loadList();
      } catch {
        setError('Черновик импортирован, но список пока не обновился.');
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const jumpToIssue = (issue: ValidationIssue) => {
    if (issue.nodeId) setPicked([{ type: 'node', id: issue.nodeId }]);
    else if (issue.edgeId) setPicked([{ type: 'edge', id: issue.edgeId }]);
    else setPicked([]);
    setMobileTab('parameters');
  };

  return (
    <div className="ed-root">
      {def && record && def.kind === 'scenario' && <AssistantPanel key={def.id} definition={def} revision={record.revision} disabled={!!busy || loading} onApply={value => {edit(value);setPicked([]);setNotice('Предложение применено. Сохраните черновик и проверьте перед публикацией.');}} />}
      <header className="ed-header">
        <div className="ed-title-line">
          <div>
            <h1>Редактор сценариев</h1>
            <p>Настройте ситуации, действия и последствия решений.</p>
          </div>
          {record && (
            <div className="ed-current">
              <strong>{def?.title}</strong>
              <span>
                {def?.kind === 'mega' ? 'Маршрут' : def?.scene ? '3D-сценарий' : 'Текстовый сценарий'} · черновик {record.revision} ·
                публикация {record.publishedVersion ?? 'нет'} ·{' '}
                {dirty ? 'есть изменения' : 'сохранено'}
              </span>
            </div>
          )}
        </div>
        <div className="ed-actions">
          {record && (
            <>
              <button
                type="button"
                className="ed-secondary"
                disabled={!!busy || !dirty}
                onClick={() => void saveDraft()}
              >
                <Save size={17} /> Сохранить
              </button>
              <button
                type="button"
                className="ed-secondary"
                disabled={!!busy}
                onClick={() => void validate()}
              >
                <Check size={17} /> Проверить
              </button>
              <button
                type="button"
                className="ed-primary"
                disabled={!!busy}
                onClick={() => void publish()}
              >
                <Send size={17} /> Опубликовать
              </button>
            </>
          )}
          {busy && (
            <span className="ed-busy">
              <LoaderCircle size={17} /> Выполняется…
            </span>
          )}
        </div>
      </header>
      {error && (
        <div className="ed-banner ed-error" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
          {conflict && (
            <>
              <button type="button" onClick={() => def && downloadJson(def)}>
                <Download size={16} /> Сохранить локальный JSON
              </button>
              <button type="button" onClick={() => record && void open(record.summary.id, true)}>
                <RotateCcw size={16} /> Загрузить серверную версию
              </button>
            </>
          )}
          {!record && (
            <button
              type="button"
              onClick={() => {
                setError('');
                setLoading(true);
                void loadList()
                  .catch((e) => setError(errorText(e)))
                  .finally(() => setLoading(false));
              }}
            >
              Повторить
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className="ed-banner ed-notice" role="status">
          <Check size={18} />
          {notice}
        </div>
      )}
      {issues.length > 0 && (
        <div className="ed-issues" role="region" aria-label="Ошибки проверки">
          <strong>Исправьте перед публикацией</strong>
          {issues.map((issue, i) => (
            <button type="button" key={`${issue.code}-${i}`} onClick={() => jumpToIssue(issue)}>
              {issue.message}
              {(issue.nodeId || issue.edgeId) && <span>Открыть параметры →</span>}
            </button>
          ))}
        </div>
      )}
      <nav className="ed-mobile-tabs" aria-label="Панели редактора">
        <button
          className={mobileTab === 'list' ? 'active' : ''}
          onClick={() => setMobileTab('list')}
        >
          Список
        </button>
        <button
          className={mobileTab === 'graph' ? 'active' : ''}
          onClick={() => setMobileTab('graph')}
        >
          Дерево
        </button>
        <button
          className={mobileTab === 'parameters' ? 'active' : ''}
          onClick={() => setMobileTab('parameters')}
        >
          Параметры
        </button>
      </nav>
      <div
        className={`ed-layout${showHierarchy ? '' : ' ed-hide-sidebar'}${showParameters ? '' : ' ed-hide-parameters'}`}
        inert={busy === 'publish'}
      >
        <aside
          className={`ed-sidebar ${mobileTab === 'list' ? 'ed-mobile-active' : ''}`}
          aria-label="Иерархия сценариев"
        >
          <div className="ed-panel-head">
            <h2>Иерархия</h2>
            <span>{list.length}</span>
          </div>
          <div className="ed-create">
            <button type="button" disabled={!!busy} onClick={() => void create('scenario')}>
              <Plus size={18} /> Сценарий
            </button>
            <button type="button" disabled={!!busy} onClick={() => void create('scenario', true)}>
              <Plus size={18} /> 3D-сценарий
            </button>
            <button type="button" disabled={!!busy} onClick={() => void create('mega')}>
              <Folder size={18} /> Маршрут
            </button>
          </div>
          <p className="ed-create-help">Сценарий — ответы на экране; 3D — вагон и действия у точек; маршрут связывает несколько сценариев.</p>
          <label className="ed-search">
            <Search size={17} />
            <span className="ed-sr">Поиск сценариев</span>
            <input
              placeholder="Поиск сценариев"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {loading ? (
            <p className="ed-empty">
              <LoaderCircle size={18} /> Загрузка сценариев…
            </p>
          ) : list.length === 0 ? (
            <p className="ed-empty">Пока нет сценариев. Создайте первый.</p>
          ) : (
            <div className="ed-tree">
              {megas.map((mega) => (
                <div
                  className="ed-tree-group"
                  key={mega.id}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id =
                      e.dataTransfer.getData('application/x-vsm-scenario') ||
                      e.dataTransfer.getData('text/plain');
                    if (id) void addMembership(id, mega.id);
                  }}
                >
                  <button
                    type="button"
                    className={`ed-tree-item ${record?.summary.id === mega.id ? 'active' : ''}`}
                    aria-expanded={record?.summary.id === mega.id && collapsedMegaId !== mega.id}
                    onClick={() => {
                      if (record?.summary.id === mega.id && def?.kind === 'mega') {
                        setCollapsedMegaId((current) => current === mega.id ? null : mega.id);
                        return;
                      }
                      void open(mega.id).then((ok) => {
                        if (ok) {
                          setCollapsedMegaId(null);
                          setParentId(null);
                        }
                      });
                    }}
                  >
                    <Folder size={17} />
                    <span>
                      {mega.title}
                      <small>
                        Маршрут ·{' '}
                        {mega.publishedVersion ? `версия ${mega.publishedVersion}` : 'черновик'}
                      </small>
                    </span>
                    <ChevronDown
                      size={15}
                      className={record?.summary.id === mega.id && collapsedMegaId !== mega.id ? 'ed-tree-chevron-open' : 'ed-tree-chevron'}
                    />
                  </button>
                  {record?.summary.id === mega.id &&
                    def?.kind === 'mega' &&
                    collapsedMegaId !== mega.id &&
                    def.childScenarioIds.map((id) => {
                      const child = ordinary.find((s) => s.id === id);
                      return (
                        <div className="ed-child-row" key={id}>
                          <button
                            type="button"
                            onClick={() => {
                              void open(id).then((ok) => {
                                if (ok) setParentId(mega.id);
                              });
                            }}
                          >
                            <GitBranch size={15} />
                            <span>{child?.title ?? id}</span>
                          </button>
                          <button
                            type="button"
                            title="Убрать из маршрута"
                            aria-label={`Убрать ${child?.title ?? id} из маршрута`}
                            onClick={() => {
                              if (
                                window.confirm(
                                  'Убрать сценарий из состава маршрута? Его исходный черновик сохранится, связанные узлы и переходы исчезнут.',
                                )
                              )
                                edit(removeChild(def, id));
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      );
                    })}
                </div>
              ))}
              {standalones.map((s) => (
                <button
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('application/x-vsm-scenario', s.id);
                    e.dataTransfer.setData('text/plain', s.id);
                  }}
                  className={`ed-tree-item ${record?.summary.id === s.id ? 'active' : ''}`}
                  key={s.id}
                  onClick={() => {
                    void open(s.id).then((ok) => {
                      if (ok) setParentId(null);
                    });
                  }}
                >
                  <GitBranch size={17} />
                  <span>
                    {s.title}
                    <small>
                      {s.presentation === 'immersive' ? '3D' : 'Текст'} · {s.publishedVersion ? `версия ${s.publishedVersion}` : 'черновик'} ·
                      перетащите в маршрут
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}
          {def?.kind === 'mega' && (
            <div className="ed-membership">
              <h3>Состав маршрута</h3>
              <p>Добавление в состав не задаёт порядок. Соедините узлы на поле.</p>
              <label className="ed-field">
                <span>Добавить сценарий</span>
                <select value={childChoice} onChange={(e) => setChildChoice(e.target.value)}>
                  <option value="">Выберите…</option>
                  {ordinary
                    .filter((s) => !def.childScenarioIds.includes(s.id))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className="ed-secondary ed-full"
                disabled={!childChoice}
                onClick={() => void addMembership(childChoice)}
              >
                Добавить в маршрут
              </button>
            </div>
          )}
          <div className="ed-portable">
            <button type="button" onClick={() => def && downloadJson(def)} disabled={!def}>
              <Download size={16} /> Скачать JSON
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy}>
              <Upload size={16} /> Импортировать
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="ed-sr"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importJson(file);
              }}
            />
          </div>
        </aside>
        <main className={`ed-workspace ${mobileTab === 'graph' ? 'ed-mobile-active' : ''}`}>
          {def && record ? (
            <>
              {parent && (
                <div className="ed-breadcrumb">
                  <button
                    type="button"
                    onClick={() => {
                      void open(parent.id).then((ok) => {
                        if (ok) setParentId(null);
                      });
                    }}
                  >
                    <ArrowLeft size={16} /> Вернуться к маршруту «{parent.title}»
                  </button>
                </div>
              )}
              <div className="ed-toolbar">
                <div className="ed-toolbar-group">
                  <button
                    type="button"
                    onClick={() => addNode(def.kind === 'mega' ? 'scenario' : 'situation')}
                  >
                    <Plus size={16} /> {def.kind === 'mega' ? 'Сценарий' : 'Ситуация'}
                  </button>
                  {def.kind === 'scenario' && (
                    <button type="button" onClick={() => addNode('answer')}>
                      <Plus size={16} /> Ответ
                    </button>
                  )}
                  {def.kind === 'scenario' && def.schemaVersion === 2 && (
                    <button
                      type="button"
                      disabled={!catalog?.commands.length}
                      onClick={() => addNode('worldAction')}
                      title={!catalog ? 'Ожидаем каталог действий сервера' : undefined}
                    >
                      <Plus size={16} /> Действие в вагоне
                    </button>
                  )}
                  <button type="button" onClick={() => addNode('end')}>
                    <Plus size={16} /> Завершение
                  </button>
                </div>
                <div className="ed-toolbar-group ed-bulk-tools">
                  <button
                    type="button"
                    aria-pressed={multiPickMode}
                    onClick={() => setMultiPickMode((value) => !value)}
                  >
                    {multiPickMode ? 'Выбор: включён' : 'Множественный выбор'}
                  </button>
                  <span className="ed-selection-count" role="status">
                    Выбрано: {picked.length}
                  </span>
                  <button
                    type="button"
                    disabled={!picked.length || !!busy}
                    onClick={duplicateSelection}
                    title="Ctrl+D / Cmd+D"
                  >
                    Дублировать
                  </button>
                  <button
                    type="button"
                    disabled={!picked.length || !!busy}
                    onClick={deleteSelection}
                    title="Delete"
                  >
                    <Trash2 size={16} /> Удалить выбранное
                  </button>
                </div>
                <div className="ed-toolbar-group ed-view-tools">
                  <button
                    type="button"
                    onClick={() => void fitView({ padding: 0.16, duration: 250 })}
                  >
                    <Maximize2 size={16} /> Показать всё
                  </button>
                  <button
                    type="button"
                    disabled={!selectedNode}
                    onClick={() => {
                      if (selectedNode)
                        void setCenter(selectedNode.position.x + 95, selectedNode.position.y + 52, {
                          zoom: 1.05,
                          duration: 250,
                        });
                    }}
                  >
                    <LocateFixed size={16} /> К узлу
                  </button>
                  <button
                    type="button"
                    className="ed-desktop-view-tool"
                    aria-label={showHierarchy ? 'Скрыть иерархию' : 'Показать иерархию'}
                    title={showHierarchy ? 'Скрыть иерархию' : 'Показать иерархию'}
                    onClick={() => setShowHierarchy((value) => !value)}
                  >
                    {showHierarchy ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                    Иерархия
                  </button>
                  <button
                    type="button"
                    className="ed-desktop-view-tool"
                    aria-label={
                      showParameters ? 'Скрыть панель параметров' : 'Показать панель параметров'
                    }
                    title={
                      showParameters ? 'Скрыть панель параметров' : 'Показать панель параметров'
                    }
                    onClick={() => setShowParameters((value) => !value)}
                  >
                    {showParameters ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                    Параметры
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPicked([]);
                    setMobileTab('parameters');
                  }}
                >
                  <CircleHelp size={16} /> Параметры сценария
                </button>
              </div>
              <div
                ref={canvasRef}
                className="ed-canvas"
                aria-label="Рабочее поле сценария"
                tabIndex={0}
              >
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onNodeClick={onNodeClick}
                  onEdgeClick={onEdgeClick}
                  onPaneClick={onPaneClick}
                  onConnect={onConnectFlow}
                  deleteKeyCode={null}
                  defaultViewport={initialViewport}
                  minZoom={0.25}
                  maxZoom={1.8}
                  nodesDraggable
                  nodesConnectable
                  elementsSelectable
                >
                  <Background gap={22} color="#d5dedc" />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
              <div className="ed-canvas-help">
                <Link2 size={16} /> Перетаскивайте узлы и соединяйте маркеры справа и слева. Масштаб
                и перемещение — мышью или жестом.
              </div>
              <details className="ed-connect-details">
                <summary>Связать узлы без перетаскивания</summary>
                <ConnectPanel def={def} onConnect={onConnectForm} />
              </details>
              <GraphOutline
                nodes={def.nodes}
                edges={def.edges}
                startNodeId={def.startNodeId}
                selectedNodeIds={selectedNodeIds}
                selectedEdgeIds={selectedEdgeIds}
                onPick={onOutlinePick}
              />
            </>
          ) : (
            <div className="ed-workspace-empty">
              <GitBranch size={40} />
              <h2>Создайте сценарий или откройте черновик</h2>
              <p>
                В дереве слева соберите ситуации, ответы и переходы. Маршрут объединяет несколько
                сценариев.
              </p>
              <button type="button" className="ed-primary" onClick={() => void create('scenario')}>
                Создать сценарий
              </button>
            </div>
          )}
        </main>
        <aside
          className={`ed-parameters ${mobileTab === 'parameters' ? 'ed-mobile-active' : ''}`}
          aria-label="Параметры выбранного элемента"
        >
          <div className="ed-panel-head">
            <h2>Параметры</h2>
          </div>
          {def ? (
            picked.length > 1 ? (
              <div className="ed-selection-summary">
                <h3>Выбрано несколько элементов</h3>
                <p>
                  {selectedNodeIds.size} узлов и {selectedEdgeIds.size} связей. Shift+клик или
                  включённый множественный выбор добавляет и убирает элементы. Обычный клик
                  оставляет один.
                </p>
                <button type="button" className="ed-secondary ed-full" onClick={duplicateSelection}>
                  Дублировать узлы
                </button>
                <button
                  type="button"
                  className="ed-text-button ed-danger"
                  onClick={deleteSelection}
                >
                  <Trash2 size={16} /> Удалить выбранное
                </button>
              </div>
            ) : selectedNode ? (
              <NodePanel
                def={def}
                node={selectedNode}
                ordinary={ordinary}
                catalog={catalog}
                onChange={edit}
                onDelete={deleteSelection}
              />
            ) : selectedEdge ? (
              <EdgePanel def={def} edge={selectedEdge} onChange={edit} onDelete={deleteSelection} />
            ) : (
              <>
                <MetadataPanel def={def} onChange={edit} />
                {def.schemaVersion === 2 && (
                  <ScenePanel def={def} onChange={edit} catalog={catalog} />
                )}
              </>
            )
          ) : (
            <p className="ed-empty">Откройте сценарий, чтобы изменить параметры.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

export default function EditorPage() {
  return (
    <ReactFlowProvider>
      <EditorPageContent />
    </ReactFlowProvider>
  );
}
