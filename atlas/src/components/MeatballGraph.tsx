import { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import {
  dishes,
  edges,
  ROUTE_COLORS,
  ROUTE_LABELS,
  ROUTE_ANGLES,
  EDGE_COLORS,
  type MeatballDish,
  type MeatballEdge,
} from '../data/meatballs';

type Selected = {
  dish: MeatballDish;
  neighbors: Array<{ id: string; name: string; route: string; edgeType: string; note?: string }>;
} | null;

type Phase =
  | 'title'
  | 'subtitle'
  | 'reveal-1'
  | 'reveal-2'
  | 'reveal-3'
  | 'reveal-4'
  | 'reveal-all'
  | 'done';

declare global {
  interface Window {
    __atlas?: {
      sigma: Sigma;
      graph: Graph;
      selectNode: (id: string) => void;
      skipCinematic: () => void;
    };
  }
}

// Sequenced reveal — Polpette → Kofta → Albóndigas → Kibbeh → all
const SCRIPT: Record<
  string,
  { nodes: string[]; edges: Array<[string, string]>; caption: string }
> = {
  'reveal-1': {
    nodes: ['polpette'],
    edges: [],
    caption: 'Polpette · Naples. The meatball you think you know.',
  },
  'reveal-2': {
    nodes: ['polpette', 'kofta-turkish'],
    edges: [['polpette', 'kofta-turkish']],
    caption: 'Polpette and köfte are kin — same root verb (Persian kuftan, "to pound"), two empires, one kitchen.',
  },
  'reveal-3': {
    nodes: ['polpette', 'kofta-turkish', 'albondigas'],
    edges: [
      ['polpette', 'kofta-turkish'],
      ['albondigas', 'kofta-turkish'],
    ],
    caption: 'Albóndigas — al-bunduq, "the hazelnut" — entered Iberia in the Andalusi period, carried by Moorish kitchens.',
  },
  'reveal-4': {
    nodes: ['polpette', 'kofta-turkish', 'albondigas', 'kibbeh'],
    edges: [
      ['polpette', 'kofta-turkish'],
      ['albondigas', 'kofta-turkish'],
      ['kofta-turkish', 'kibbeh'],
    ],
    caption: 'Kibbeh keeps the bulgur jacket the others dropped. The torpedo to their sphere.',
  },
};

const CINEMATIC_SEEN_KEY = 'spence-atlas-cinematic-seen-v1';

// Radial layout — anchor each dish in its route's angular sector.
// Route='none' dishes are routed into the sector of their dominant non-none neighbor,
// placed in an inner ring (they're the ancestral/cross-route hubs).
function computeRadialPositions(degree: Map<string, number>) {
  const dishById = new Map(dishes.map((d) => [d.id, d]));

  // Compute each dish's "effective route" — for route='none', use the modal route of its non-none neighbors.
  const effectiveRoute = new Map<string, string>();
  for (const d of dishes) {
    if (d.route !== 'none') {
      effectiveRoute.set(d.id, d.route);
      continue;
    }
    const tally = new Map<string, number>();
    for (const e of edges) {
      const other = e.from === d.id ? dishById.get(e.to) : e.to === d.id ? dishById.get(e.from) : undefined;
      if (other && other.route !== 'none') {
        tally.set(other.route, (tally.get(other.route) ?? 0) + 1);
      }
    }
    const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'orphan';
    effectiveRoute.set(d.id, dominant);
  }

  // Group by effective route
  const byRoute = new Map<string, Array<{ dish: MeatballDish; isNoneOrigin: boolean }>>();
  for (const d of dishes) {
    const er = effectiveRoute.get(d.id)!;
    if (!byRoute.has(er)) byRoute.set(er, []);
    byRoute.get(er)!.push({ dish: d, isNoneOrigin: d.route === 'none' });
  }

  const positions = new Map<string, { x: number; y: number }>();

  for (const [route, list] of byRoute) {
    // Sort: 'none'-origin hubs first (will sit inner), then route-origin by degree desc
    list.sort((a, b) => {
      if (a.isNoneOrigin !== b.isNoneOrigin) return a.isNoneOrigin ? -1 : 1;
      return (degree.get(b.dish.id) ?? 0) - (degree.get(a.dish.id) ?? 0);
    });

    if (route === 'orphan') {
      // No route-anchored neighbors — place in deep inner orbit
      const n = list.length;
      list.forEach((entry, i) => {
        const angle = (i / Math.max(1, n)) * 2 * Math.PI + Math.PI / 8;
        const r = 5.5;
        positions.set(entry.dish.id, { x: r * Math.cos(angle), y: r * Math.sin(angle) });
      });
      continue;
    }

    const baseAngle = ROUTE_ANGLES[route] ?? 0;
    const n = list.length;
    const noneCount = list.filter((x) => x.isNoneOrigin).length;
    const routeCount = n - noneCount;
    // Arc widens with population, but never crashes adjacent sectors (max ~52° of 60° wedge).
    const arc = Math.min(Math.PI * 0.5, 0.22 * Math.PI + n * 0.035);

    list.forEach((entry, i) => {
      if (entry.isNoneOrigin) {
        // Inner ring — hubs sit close (but not at the center, which is reserved for the label)
        const t = noneCount > 1 ? i / (noneCount - 1) : 0.5;
        const innerArc = Math.min(arc * 0.85, Math.PI * 0.36);
        const angle = baseAngle - innerArc / 2 + t * innerArc;
        const radius = 7.5;
        positions.set(entry.dish.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
      } else {
        const routeIdx = i - noneCount;
        const ring = Math.floor(routeIdx / 3);
        const inRing = routeIdx % 3;
        const remainingInRing = Math.min(3, routeCount - ring * 3);
        const t = remainingInRing > 1 ? inRing / (remainingInRing - 1) : 0.5;
        const angle = baseAngle - arc / 2 + t * arc;
        const radius = 11 + ring * 4;
        positions.set(entry.dish.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
      }
    });
  }
  return positions;
}

export default function MeatballGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [hovered, setHovered] = useState<{ dish: MeatballDish; x: number; y: number } | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [phase, setPhase] = useState<Phase>('title');
  const [aboutOpen, setAboutOpen] = useState(false);
  const phaseRef = useRef<Phase>('title');
  phaseRef.current = phase;

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 720);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Cinematic timeline. Skip if: returning visitor, ?skip=1, ?dish=X, or prefers-reduced-motion.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const seen = typeof localStorage !== 'undefined' && localStorage.getItem(CINEMATIC_SEEN_KEY) === '1';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (params.get('skip') === '1' || params.get('dish') || seen || reducedMotion) {
      setPhase('done');
      return;
    }
    const narrow = window.matchMedia('(max-width: 480px)').matches;
    // Mobile shorter — thumb fatigue, scrollers bounce faster
    const steps: Array<{ at: number; phase: Phase }> = narrow
      ? [
          { at: 0, phase: 'title' },
          { at: 1100, phase: 'subtitle' },
          { at: 2100, phase: 'reveal-1' },
          { at: 3200, phase: 'reveal-2' },
          { at: 4400, phase: 'reveal-3' },
          { at: 5700, phase: 'reveal-4' },
          { at: 7100, phase: 'reveal-all' },
          { at: 8200, phase: 'done' },
        ]
      : [
          { at: 0, phase: 'title' },
          { at: 1500, phase: 'subtitle' },
          { at: 2700, phase: 'reveal-1' },
          { at: 4000, phase: 'reveal-2' },
          { at: 5600, phase: 'reveal-3' },
          { at: 7300, phase: 'reveal-4' },
          { at: 9200, phase: 'reveal-all' },
          { at: 10800, phase: 'done' },
        ];
    const timers = steps.map((s) => setTimeout(() => setPhase(s.phase), s.at));
    return () => timers.forEach(clearTimeout);
  }, []);

  // Mark cinematic seen so reloads don't replay
  useEffect(() => {
    if (phase === 'done') {
      try {
        localStorage.setItem(CINEMATIC_SEEN_KEY, '1');
      } catch {}
    }
  }, [phase]);

  // Refresh sigma when phase changes (so reducers re-run)
  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [phase]);

  const skipCinematic = () => setPhase('done');

  useEffect(() => {
    if (!containerRef.current) return;

    const graph = new Graph({ multi: false });

    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }

    const positions = computeRadialPositions(degree);

    for (const dish of dishes) {
      const p = positions.get(dish.id) ?? { x: 0, y: 0 };
      const deg = degree.get(dish.id) ?? 1;
      const size = 6 + 3.2 * Math.sqrt(deg);
      const color = ROUTE_COLORS[dish.route] ?? ROUTE_COLORS.none;
      graph.addNode(dish.id, {
        label: dish.name,
        x: p.x,
        y: p.y,
        size,
        color,
        baseColor: color,
        baseSize: size,
        dish,
        forceLabel: deg >= 5,
      });
    }

    for (const edge of edges) {
      if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
      if (graph.hasEdge(edge.from, edge.to)) continue;
      const color = EDGE_COLORS[edge.type] ?? 'rgba(247,237,226,0.25)';
      graph.addEdge(edge.from, edge.to, {
        size: edge.type === 'descends-from' ? 1.8 : edge.type === 'migrated-via' ? 1.4 : 1.0,
        color,
        baseColor: color,
        edgeType: edge.type,
        via: edge.via,
        note: edge.note,
      });
    }

    // No FA2 — the radial layout is the truth. FA2 just blurs the route sectors.
    // Suppress unused-import lint by referencing the symbol once:
    void forceAtlas2;

    const renderer = new Sigma(graph, containerRef.current, {
      defaultNodeColor: ROUTE_COLORS.none,
      defaultEdgeColor: 'rgba(247,237,226,0.25)',
      labelColor: { color: '#F7EDE2' },
      labelSize: 12,
      labelFont: '"Inter", system-ui, sans-serif',
      labelWeight: '500',
      labelDensity: 1.4,
      labelGridCellSize: 70,
      labelRenderedSizeThreshold: 8,
      renderEdgeLabels: false,
      minCameraRatio: 0.25,
      maxCameraRatio: 3,
      nodeReducer: (nodeId, data) => {
        const p = phaseRef.current;
        if (p === 'done' || p === 'reveal-all') return data;
        if (p === 'title' || p === 'subtitle') {
          return { ...data, hidden: true };
        }
        const allowed = SCRIPT[p]?.nodes ?? [];
        if (allowed.includes(nodeId)) {
          // Highlight the just-revealed node — bigger, with full color
          const isLatest = allowed[allowed.length - 1] === nodeId;
          return {
            ...data,
            size: isLatest ? data.size * 1.3 : data.size,
            forceLabel: true,
          };
        }
        return { ...data, hidden: true };
      },
      edgeReducer: (edgeId, data) => {
        const p = phaseRef.current;
        if (p === 'done' || p === 'reveal-all') return data;
        const allowed = SCRIPT[p]?.edges ?? [];
        if (!graph) return { ...data, hidden: true };
        const src = graph.source(edgeId);
        const tgt = graph.target(edgeId);
        const match = allowed.some(([a, b]) => (a === src && b === tgt) || (a === tgt && b === src));
        if (match) {
          return { ...data, size: data.size * 1.6, color: 'rgba(247,237,226,0.85)' };
        }
        return { ...data, hidden: true };
      },
    });

    sigmaRef.current = renderer;
    graphRef.current = graph;

    const FADE_NODE = 'rgba(247,237,226,0.07)';
    const FADE_EDGE = 'rgba(247,237,226,0.03)';

    const clearHighlight = () => {
      graph.forEachNode((n) => {
        graph.setNodeAttribute(n, 'color', graph.getNodeAttribute(n, 'baseColor'));
      });
      graph.forEachEdge((e) => {
        graph.setEdgeAttribute(e, 'color', graph.getEdgeAttribute(e, 'baseColor'));
      });
      renderer.refresh();
    };

    const highlight = (nodeId: string) => {
      const neighborSet = new Set(graph.neighbors(nodeId));
      neighborSet.add(nodeId);
      graph.forEachNode((n) => {
        graph.setNodeAttribute(n, 'color', neighborSet.has(n) ? graph.getNodeAttribute(n, 'baseColor') : FADE_NODE);
      });
      graph.forEachEdge((e, _attrs, src, tgt) => {
        const onPath = src === nodeId || tgt === nodeId;
        if (onPath) {
          // Use a stronger version of the base color for traversal edges
          const base = graph.getEdgeAttribute(e, 'baseColor') as string;
          graph.setEdgeAttribute(e, 'color', base.replace(/[\d.]+\)$/, '0.78)'));
        } else {
          graph.setEdgeAttribute(e, 'color', FADE_EDGE);
        }
      });
      renderer.refresh();
    };

    const selectNode = (nodeId: string) => {
      const dish = graph.getNodeAttribute(nodeId, 'dish') as MeatballDish;
      const neighbors = graph.neighbors(nodeId).map((n) => {
        const edgeKey = graph.edge(nodeId, n) ?? graph.edge(n, nodeId);
        return {
          id: n,
          name: graph.getNodeAttribute(n, 'label') as string,
          route: (graph.getNodeAttribute(n, 'dish') as MeatballDish).route,
          edgeType: edgeKey ? (graph.getEdgeAttribute(edgeKey, 'edgeType') as string) : '',
          note: edgeKey ? (graph.getEdgeAttribute(edgeKey, 'note') as string | undefined) : undefined,
        };
      });
      setSelected({ dish, neighbors });
      highlight(nodeId);
    };

    renderer.on('clickNode', ({ node }) => selectNode(node));
    renderer.on('clickStage', () => {
      setSelected(null);
      setHovered(null);
      clearHighlight();
    });

    renderer.on('enterNode', ({ node, event }) => {
      const dish = graph.getNodeAttribute(node, 'dish') as MeatballDish;
      setHovered({ dish, x: event.x, y: event.y });
      document.body.style.cursor = 'pointer';
    });
    renderer.on('leaveNode', () => {
      setHovered(null);
      document.body.style.cursor = '';
    });
    renderer.on('moveBody', () => {
      setHovered((h) => (h ? null : h));
    });

    // Keyboard: Esc clears, ? opens about, Space skips cinematic
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (phaseRef.current !== 'done') {
          setPhase('done');
          return;
        }
        setSelected(null);
        setHovered(null);
        setAboutOpen(false);
        clearHighlight();
      } else if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        if (phaseRef.current === 'done') setAboutOpen((v) => !v);
      } else if (e.key === ' ' && phaseRef.current !== 'done') {
        e.preventDefault();
        setPhase('done');
      }
    };
    window.addEventListener('keydown', onKey);

    // Expose for E2E tests & deep-link selection
    window.__atlas = { sigma: renderer, graph, selectNode, skipCinematic };

    // Deep-link: ?dish=polpette pre-selects
    const params = new URLSearchParams(window.location.search);
    const initial = params.get('dish');
    if (initial && graph.hasNode(initial)) {
      // Wait a tick so the layout renders first
      setTimeout(() => selectNode(initial), 200);
    }

    return () => {
      window.removeEventListener('keydown', onKey);
      renderer.kill();
      graph.clear();
      sigmaRef.current = null;
      graphRef.current = null;
      delete window.__atlas;
      document.body.style.cursor = '';
    };
  }, []);

  const resetView = () => {
    const r = sigmaRef.current;
    if (!r) return;
    r.getCamera().animatedReset({ duration: 500 });
    setSelected(null);
    setHovered(null);
  };

  const shareLink = selected
    ? `${window.location.origin}${window.location.pathname}?dish=${selected.dish.id}`
    : null;

  const routeLegend = Object.entries(ROUTE_COLORS).filter(([k]) => k !== 'none');

  return (
    <>
      <div
        ref={containerRef}
        role="img"
        aria-label="Interactive graph of 40 meatball-family dishes connected by trade-route kinship edges"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'radial-gradient(ellipse at center, #1A1612 0%, #0A0807 70%, #050403 100%)',
        }}
      />

      {/* Center label — the conceptual hero of the graph */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: 'rgba(247,237,226,0.22)',
          fontFamily: '"Inter", system-ui, sans-serif',
          fontWeight: 500,
          fontSize: isMobile ? 14 : 20,
          letterSpacing: '0.42em',
          textTransform: 'uppercase',
          pointerEvents: 'none',
          textAlign: 'center',
          zIndex: 1,
          textShadow: '0 0 60px rgba(0,0,0,0.95), 0 0 18px rgba(0,0,0,0.9)',
          lineHeight: 1.35,
        }}
      >
        the
        <br />
        meatball
      </div>

      {/* Masthead — phased fade-in during cinematic, fully present after */}
      <header
        style={{
          position: 'fixed',
          top: isMobile ? 16 : 28,
          left: isMobile ? 18 : 32,
          color: '#F7EDE2',
          fontFamily: '"Inter", system-ui, sans-serif',
          pointerEvents: 'none',
          zIndex: 10,
          maxWidth: isMobile ? 'calc(100vw - 36px)' : 520,
          transition: 'opacity 800ms ease-out',
          opacity: phase === 'title' ? 0 : 1,
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            color: '#C9B79C',
            opacity: 0.72,
            marginBottom: 6,
            transition: 'opacity 600ms',
          }}
        >
          Spence Atlas
        </div>
        <h1
          style={{
            fontSize: isMobile ? 32 : 48,
            margin: '0 0 8px',
            fontWeight: 600,
            letterSpacing: '-0.025em',
            lineHeight: 1.02,
          }}
        >
          The Meatball Atlas
        </h1>
        <p
          style={{
            fontSize: isMobile ? 13 : 15,
            color: '#F7EDE2',
            opacity: phase === 'subtitle' || phase === 'reveal-1' || phase === 'reveal-2' || phase === 'reveal-3' || phase === 'reveal-4' || phase === 'reveal-all' || phase === 'done' ? 0.78 : 0,
            maxWidth: 440,
            margin: 0,
            lineHeight: 1.5,
            transition: 'opacity 800ms ease-out',
          }}
        >
          40 dishes. 6 trade routes. One Platonic meatball.
          <br />
          <span style={{ opacity: 0.7 }}>Click a node · Esc to clear · ? for about</span>
        </p>
      </header>

      {/* Cinematic title overlay — huge centered type that fades during the title beat only */}
      {phase === 'title' && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            pointerEvents: 'none',
            animation: 'atlasTitleFade 1500ms ease-out forwards',
          }}
        >
          <div
            style={{
              fontFamily: '"Inter", system-ui, sans-serif',
              fontSize: isMobile ? 11 : 13,
              letterSpacing: '0.42em',
              textTransform: 'uppercase',
              color: '#C9B79C',
              opacity: 0.7,
              marginBottom: 18,
            }}
          >
            Spence Atlas
          </div>
          <div
            style={{
              fontFamily: '"Inter", system-ui, sans-serif',
              fontSize: isMobile ? 40 : 72,
              fontWeight: 600,
              letterSpacing: '-0.025em',
              color: '#F7EDE2',
              textAlign: 'center',
              lineHeight: 1,
            }}
          >
            The Meatball Atlas
          </div>
        </div>
      )}

      {/* Cinematic caption strip — appears during reveal-1 through reveal-4 */}
      {(phase === 'reveal-1' || phase === 'reveal-2' || phase === 'reveal-3' || phase === 'reveal-4') && (
        <div
          aria-live="polite"
          style={{
            position: 'fixed',
            top: isMobile ? 'auto' : '50%',
            bottom: isMobile ? 120 : 'auto',
            left: '50%',
            transform: isMobile ? 'translateX(-50%)' : 'translate(-50%, -50%) translateY(160px)',
            maxWidth: isMobile ? 'calc(100vw - 36px)' : 620,
            padding: isMobile ? '14px 18px' : '16px 24px',
            background: 'rgba(15,12,10,0.78)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(247,237,226,0.08)',
            borderRadius: 6,
            color: '#F7EDE2',
            fontFamily: '"Inter", system-ui, sans-serif',
            fontSize: isMobile ? 14 : 17,
            lineHeight: 1.45,
            textAlign: 'center',
            letterSpacing: '-0.005em',
            zIndex: 40,
            pointerEvents: 'none',
            animation: 'captionPop 480ms cubic-bezier(0.16, 1, 0.3, 1) both',
          }}
          key={phase}
        >
          {SCRIPT[phase]?.caption}
        </div>
      )}

      {/* Skip cinematic button — 44pt minimum tap target per HIG */}
      {phase !== 'done' && (
        <button
          onClick={skipCinematic}
          aria-label="Skip introduction"
          style={{
            position: 'fixed',
            top: `max(env(safe-area-inset-top, 0px), ${isMobile ? 12 : 20}px)`,
            right: `max(env(safe-area-inset-right, 0px), ${isMobile ? 14 : 24}px)`,
            minHeight: 44,
            minWidth: 44,
            padding: '10px 16px',
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            background: 'rgba(15,12,10,0.7)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(247,237,226,0.12)',
            color: '#C9B79C',
            cursor: 'pointer',
            borderRadius: 4,
            fontFamily: '"Inter", system-ui, sans-serif',
            zIndex: 60,
          }}
        >
          Skip intro ›
        </button>
      )}

      {/* About button — visible only after cinematic */}
      {phase === 'done' && (
        <button
          onClick={() => setAboutOpen(true)}
          aria-label="About this project"
          title="About"
          style={{
            position: 'fixed',
            top: isMobile ? 16 : 24,
            right: isMobile ? 18 : 28,
            width: 32,
            height: 32,
            background: 'rgba(15,12,10,0.7)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(247,237,226,0.12)',
            color: '#F7EDE2',
            cursor: 'pointer',
            borderRadius: '50%',
            fontFamily: '"Inter", system-ui, sans-serif',
            fontSize: 14,
            fontWeight: 500,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
        >
          ?
        </button>
      )}

      {/* Controls — bottom-right */}
      <div
        style={{
          position: 'fixed',
          bottom: isMobile ? 18 : 26,
          right: isMobile ? 18 : 26,
          display: 'flex',
          gap: 6,
          zIndex: 10,
        }}
      >
        <Control onClick={resetView} label="Reset view">⟲</Control>
        <Control
          onClick={() => {
            const r = sigmaRef.current;
            if (!r) return;
            const cam = r.getCamera();
            cam.animatedZoom({ duration: 220 });
          }}
          label="Zoom in"
        >
          +
        </Control>
        <Control
          onClick={() => {
            const r = sigmaRef.current;
            if (!r) return;
            const cam = r.getCamera();
            cam.animatedUnzoom({ duration: 220 });
          }}
          label="Zoom out"
        >
          −
        </Control>
      </div>

      {/* Legend — bottom-left */}
      <div
        style={{
          position: 'fixed',
          bottom: isMobile ? 18 : 26,
          left: isMobile ? 18 : 32,
          color: '#F7EDE2',
          fontFamily: '"Inter", system-ui, sans-serif',
          fontSize: 11,
          letterSpacing: '0.04em',
          zIndex: 10,
          pointerEvents: 'none',
          background: 'rgba(10,8,7,0.5)',
          backdropFilter: 'blur(8px)',
          padding: '10px 14px',
          borderRadius: 4,
          border: '1px solid rgba(247,237,226,0.06)',
        }}
      >
        <div
          style={{
            marginBottom: 8,
            color: '#C9B79C',
            opacity: 0.8,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            fontSize: 9,
          }}
        >
          Trade Routes
        </div>
        {routeLegend.map(([key, color]) => {
          // First letter as a glyph token — color-blind users can distinguish via letter even when hue collapses
          const glyph = ROUTE_LABELS[key]?.[0] ?? '·';
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4, fontSize: 11 }}>
              <span
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: '50%',
                  background: color,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 9,
                  fontWeight: 700,
                  color: 'rgba(15,12,10,0.85)',
                  boxShadow: `0 0 8px ${color}55`,
                  letterSpacing: 0,
                }}
                aria-hidden="true"
              >
                {glyph}
              </span>
              <span style={{ opacity: 0.88 }}>{ROUTE_LABELS[key]}</span>
            </div>
          );
        })}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 6, fontSize: 11, opacity: 0.6 }}>
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: '50%',
              background: ROUTE_COLORS.none,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 9,
              fontWeight: 700,
              color: 'rgba(15,12,10,0.85)',
            }}
            aria-hidden="true"
          >
            L
          </span>
          <span>Local / unattributed</span>
        </div>
      </div>

      {/* Hover preview tooltip */}
      {hovered && !selected && (
        <div
          style={{
            position: 'fixed',
            left: Math.min(hovered.x + 16, window.innerWidth - 240),
            top: Math.min(hovered.y + 16, window.innerHeight - 110),
            padding: '10px 14px',
            background: 'rgba(10,8,7,0.94)',
            backdropFilter: 'blur(10px)',
            border: `1px solid ${ROUTE_COLORS[hovered.dish.route]}40`,
            borderRadius: 4,
            color: '#F7EDE2',
            fontFamily: '"Inter", system-ui, sans-serif',
            fontSize: 12,
            maxWidth: 220,
            zIndex: 30,
            pointerEvents: 'none',
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2, letterSpacing: '-0.01em' }}>
            {hovered.dish.name}
          </div>
          <div style={{ fontSize: 11, color: '#C9B79C', opacity: 0.85 }}>
            {hovered.dish.place} · {hovered.dish.era}
          </div>
          <div style={{ fontSize: 10, color: ROUTE_COLORS[hovered.dish.route], marginTop: 4, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
            {ROUTE_LABELS[hovered.dish.route] ?? 'Local'}
          </div>
        </div>
      )}

      {/* Side panel — desktop right, mobile bottom sheet */}
      {selected && (
        <aside
          aria-label={`Details for ${selected.dish.name}`}
          style={{
            position: 'fixed',
            ...(isMobile
              ? {
                  bottom: 0,
                  left: 0,
                  right: 0,
                  maxHeight: '62vh',
                  overflowY: 'auto',
                  borderRadius: '12px 12px 0 0',
                  borderTop: '1px solid rgba(247,237,226,0.10)',
                }
              : {
                  top: 24,
                  right: 24,
                  width: 360,
                  maxWidth: 'calc(100vw - 48px)',
                  maxHeight: 'calc(100vh - 48px)',
                  overflowY: 'auto',
                  borderRadius: 6,
                  border: '1px solid rgba(247,237,226,0.08)',
                }),
            padding: '24px 26px 24px',
            background: 'rgba(15, 12, 10, 0.96)',
            backdropFilter: 'blur(18px)',
            color: '#F7EDE2',
            fontFamily: '"Inter", system-ui, sans-serif',
            zIndex: 20,
            boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
          }}
        >
          <button
            onClick={() => {
              setSelected(null);
              const g = graphRef.current;
              const r = sigmaRef.current;
              if (!g || !r) return;
              g.forEachNode((n) => g.setNodeAttribute(n, 'color', g.getNodeAttribute(n, 'baseColor')));
              g.forEachEdge((e) => g.setEdgeAttribute(e, 'color', g.getEdgeAttribute(e, 'baseColor')));
              r.refresh();
            }}
            aria-label="Close details"
            style={{
              position: 'absolute',
              top: 14,
              right: 14,
              width: 28,
              height: 28,
              background: 'rgba(247,237,226,0.06)',
              border: '1px solid rgba(247,237,226,0.08)',
              borderRadius: 4,
              color: '#F7EDE2',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            ✕
          </button>
          <div
            style={{
              fontSize: 10,
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              color: ROUTE_COLORS[selected.dish.route] ?? '#C9B79C',
              marginBottom: 6,
              fontWeight: 600,
            }}
          >
            {ROUTE_LABELS[selected.dish.route] ?? 'Local'}
          </div>
          <h2 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.015em' }}>
            {selected.dish.name}
          </h2>
          <div style={{ fontSize: 12, color: '#C9B79C', opacity: 0.86, marginTop: 4, letterSpacing: '0.02em' }}>
            {selected.dish.place} · {selected.dish.era}
          </div>
          <p style={{ fontSize: 14.5, lineHeight: 1.58, marginTop: 16, color: '#F7EDE2', opacity: 0.93 }}>
            {selected.dish.one_liner}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14, fontSize: 11 }}>
            <Tag label={selected.dish.binder} kind="Binder" />
            <Tag label={selected.dish.fat} kind="Fat" />
            <Tag label={selected.dish.cooked_in.replace(/_/g, ' ')} kind="Cooked in" />
          </div>
          {selected.neighbors.length > 0 && (
            <>
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: '0.22em',
                  textTransform: 'uppercase',
                  color: '#C9B79C',
                  opacity: 0.78,
                  marginTop: 22,
                  marginBottom: 10,
                  fontWeight: 600,
                }}
              >
                Kinship ({selected.neighbors.length})
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13, lineHeight: 1.55 }}>
                {selected.neighbors.map((n) => (
                  <li key={n.id} style={{ marginBottom: 8, opacity: 0.93 }}>
                    <button
                      onClick={() => window.__atlas?.selectNode(n.id)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#F7EDE2',
                        cursor: 'pointer',
                        padding: 0,
                        fontFamily: 'inherit',
                        fontSize: 13,
                        textAlign: 'left',
                        textDecoration: 'underline',
                        textDecorationColor: ROUTE_COLORS[n.route] + '88',
                        textUnderlineOffset: 3,
                      }}
                    >
                      {n.name}
                    </button>
                    <span style={{ color: '#C9B79C', opacity: 0.6, fontSize: 11, marginLeft: 6 }}>
                      {n.edgeType}
                    </span>
                    {n.note && (
                      <div style={{ fontSize: 11, color: '#C9B79C', opacity: 0.72, marginTop: 2, lineHeight: 1.4 }}>
                        {n.note}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {shareLink && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(247,237,226,0.06)' }}>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(shareLink).catch(() => {});
                }}
                style={{
                  fontSize: 11,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  background: 'transparent',
                  border: '1px solid rgba(247,237,226,0.12)',
                  color: '#C9B79C',
                  padding: '6px 12px',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Copy link
              </button>
            </div>
          )}
        </aside>
      )}

      {/* About modal */}
      {aboutOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="About The Meatball Atlas"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAboutOpen(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5,4,3,0.78)',
            backdropFilter: 'blur(8px)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            style={{
              maxWidth: 560,
              width: '100%',
              maxHeight: '80vh',
              overflowY: 'auto',
              padding: '32px 36px',
              background: 'rgba(15,12,10,0.98)',
              border: '1px solid rgba(247,237,226,0.10)',
              borderRadius: 8,
              color: '#F7EDE2',
              fontFamily: '"Inter", system-ui, sans-serif',
              boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
              lineHeight: 1.6,
            }}
          >
            <button
              onClick={() => setAboutOpen(false)}
              aria-label="Close"
              style={{
                position: 'absolute',
                top: 16,
                right: 16,
                width: 30,
                height: 30,
                background: 'rgba(247,237,226,0.06)',
                border: '1px solid rgba(247,237,226,0.10)',
                borderRadius: 4,
                color: '#F7EDE2',
                cursor: 'pointer',
                fontSize: 14,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
            >
              ✕
            </button>
            <div
              style={{
                fontSize: 10,
                letterSpacing: '0.28em',
                textTransform: 'uppercase',
                color: '#C9B79C',
                opacity: 0.78,
                marginBottom: 10,
              }}
            >
              Spence Atlas · About
            </div>
            <h2 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>
              The Meatball Atlas
            </h2>
            <p style={{ marginTop: 14, fontSize: 14.5, opacity: 0.92 }}>
              A map of 40 meatball-family dishes connected by the trade routes that carried them — Ottoman expansion,
              Moorish Iberia, Silk Road, Hanseatic / North Sea, the Columbian Exchange, and modern diaspora.
            </p>
            <p style={{ marginTop: 14, fontSize: 14.5, opacity: 0.88 }}>
              The center is empty on purpose. There is no single ancestral meatball — there are routes, and dishes that
              hang off them. Each node is a place, an era, and a build. Each edge is a documented kinship.
            </p>
            <div
              style={{
                fontSize: 10,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: '#C9B79C',
                opacity: 0.78,
                marginTop: 24,
                marginBottom: 8,
                fontWeight: 600,
              }}
            >
              Method
            </div>
            <p style={{ margin: 0, fontSize: 13.5, opacity: 0.85 }}>
              Dishes are tagged to <em>places</em>, not nations. Edges are typed —{' '}
              <code style={{ background: 'rgba(247,237,226,0.06)', padding: '1px 6px', borderRadius: 3 }}>cousin-of</code>,{' '}
              <code style={{ background: 'rgba(247,237,226,0.06)', padding: '1px 6px', borderRadius: 3 }}>descends-from</code>,{' '}
              <code style={{ background: 'rgba(247,237,226,0.06)', padding: '1px 6px', borderRadius: 3 }}>migrated-via</code>,{' '}
              <code style={{ background: 'rgba(247,237,226,0.06)', padding: '1px 6px', borderRadius: 3 }}>diaspora-of</code>,{' '}
              <code style={{ background: 'rgba(247,237,226,0.06)', padding: '1px 6px', borderRadius: 3 }}>transformed-by</code>{' '}
              — and never adjudicate authenticity. Contested origins remain contested.
            </p>
            <div
              style={{
                fontSize: 10,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: '#C9B79C',
                opacity: 0.78,
                marginTop: 24,
                marginBottom: 8,
                fontWeight: 600,
              }}
            >
              Scope · v0
            </div>
            <p style={{ margin: 0, fontSize: 13.5, opacity: 0.85 }}>
              40 of an estimated ~2,000 archetypal dishes. The meatball is one of ~200 archetypes. The Silk Road and
              Columbian Exchange atlases come next. Etymology citations and per-claim sources are forthcoming.
            </p>
            <div
              style={{
                fontSize: 10,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: '#C9B79C',
                opacity: 0.78,
                marginTop: 24,
                marginBottom: 8,
                fontWeight: 600,
              }}
            >
              Shortcuts
            </div>
            <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.7 }}>
              <div><Kbd>Click</Kbd> a node to follow its kin</div>
              <div><Kbd>Esc</Kbd> clear selection</div>
              <div><Kbd>?</Kbd> open / close this panel</div>
              <div><Kbd>+</Kbd> <Kbd>−</Kbd> zoom</div>
            </div>
            <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px solid rgba(247,237,226,0.06)' }}>
              <button
                onClick={() => {
                  try { localStorage.removeItem(CINEMATIC_SEEN_KEY); } catch {}
                  setAboutOpen(false);
                  window.location.reload();
                }}
                style={{
                  fontSize: 11,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  background: 'transparent',
                  border: '1px solid rgba(247,237,226,0.12)',
                  color: '#C9B79C',
                  padding: '7px 14px',
                  borderRadius: 3,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Replay intro
              </button>
            </div>
          </div>
        </div>
      )}

      {/* A11y mirror — hidden visual list for screen readers AND keyboard users.
          Keyboard users can Tab through these and activate them via Enter to open the side panel,
          rather than full-page-reload navigation. */}
      <nav
        aria-label="All dishes by route — keyboard-accessible kinship explorer"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
          // But: when focused-within, lift this so keyboard users SEE focus rings.
          // Browsers respect clip-path on parent, so we don't lift this visibly — focus rings still go to the page.
        }}
      >
        <h2>All dishes by trade route</h2>
        <p>Press Tab to walk through dishes. Press Enter to open a dish.</p>
        {Object.keys(ROUTE_LABELS).map((route) => {
          const list = dishes.filter((d) => d.route === route);
          if (list.length === 0) return null;
          return (
            <section key={route}>
              <h3>{ROUTE_LABELS[route]}</h3>
              <ul>
                {list.map((d) => (
                  <li key={d.id}>
                    <a
                      href={`?dish=${d.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        window.__atlas?.skipCinematic();
                        window.__atlas?.selectNode(d.id);
                      }}
                    >
                      {d.name} — {d.place}, {d.era}. {d.one_liner}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>

      {/* Live region — announces selection changes to screen readers */}
      <div aria-live="polite" aria-atomic="true" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>
        {selected ? `Selected: ${selected.dish.name}. ${selected.dish.place}, ${selected.dish.era}. ${selected.dish.one_liner} Connected to ${selected.neighbors.length} kin.` : ''}
      </div>
    </>
  );
}

function Control({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 36,
        height: 36,
        background: 'rgba(15,12,10,0.85)',
        border: '1px solid rgba(247,237,226,0.10)',
        backdropFilter: 'blur(8px)',
        color: '#F7EDE2',
        fontSize: 16,
        cursor: 'pointer',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        background: 'rgba(247,237,226,0.08)',
        border: '1px solid rgba(247,237,226,0.10)',
        borderRadius: 3,
        fontSize: 11,
        fontFamily: '"Inter", system-ui, sans-serif',
        letterSpacing: '0.04em',
        margin: '0 2px 0 0',
        color: '#F7EDE2',
      }}
    >
      {children}
    </kbd>
  );
}

function Tag({ label, kind }: { label: string; kind: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 6,
        padding: '5px 10px',
        background: 'rgba(247,237,226,0.06)',
        border: '1px solid rgba(247,237,226,0.08)',
        borderRadius: 3,
        color: '#F7EDE2',
        opacity: 0.92,
        fontSize: 11,
        letterSpacing: '0.01em',
      }}
    >
      <span style={{ color: '#C9B79C', opacity: 0.74 }}>{kind}:</span>
      <span style={{ textTransform: 'capitalize' }}>{label}</span>
    </span>
  );
}
