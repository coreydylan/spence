import { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { storyNodes, storyEdges, scenes, type Scene } from '../data/tempura-story';

gsap.registerPlugin(ScrollTrigger);

declare global {
  interface Window {
    __atlasStory?: { sigma: Sigma; graph: Graph; goTo: (sceneIndex: number) => void };
  }
}

export default function TempuraStory() {
  const stageRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const activeSceneRef = useRef<number>(-1);
  const [activeScene, setActiveScene] = useState<number>(-1);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 820);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Build the Sigma graph once
  useEffect(() => {
    if (!stageRef.current) return;
    const graph = new Graph({ multi: false });

    for (const n of storyNodes) {
      graph.addNode(n.id, {
        label: n.name,
        x: n.x,
        y: -n.y,
        size: 12,
        color: n.color,
        baseColor: n.color,
        forceLabel: true,
        meta: n,
      });
    }
    for (const e of storyEdges) {
      if (!graph.hasNode(e.from) || !graph.hasNode(e.to)) continue;
      graph.addEdge(e.from, e.to, {
        size: 1.5,
        color: e.color ?? 'rgba(247,237,226,0.35)',
        baseColor: e.color ?? 'rgba(247,237,226,0.35)',
        label: e.label ?? '',
      });
    }

    const renderer = new Sigma(graph, stageRef.current, {
      defaultEdgeColor: 'rgba(247,237,226,0.35)',
      labelColor: { color: '#F7EDE2' },
      labelSize: 13,
      labelFont: '"Inter", system-ui, sans-serif',
      labelWeight: '500',
      renderEdgeLabels: true,
      edgeLabelColor: { color: '#C9B79C' },
      edgeLabelSize: 10,
      edgeLabelFont: '"Inter", system-ui, sans-serif',
      edgeLabelWeight: '400',
      minCameraRatio: 0.4,
      maxCameraRatio: 2.5,
      nodeReducer: (nodeId, data) => {
        const idx = activeSceneRef.current;
        if (idx < 0) return { ...data, hidden: true };
        const scene = scenes[idx];
        if (!scene) return data;
        if (!scene.nodes.includes(nodeId)) return { ...data, hidden: true };
        return data;
      },
      edgeReducer: (edgeId, data) => {
        const idx = activeSceneRef.current;
        if (idx < 0) return { ...data, hidden: true };
        const scene = scenes[idx];
        if (!scene) return data;
        const src = graph.source(edgeId);
        const tgt = graph.target(edgeId);
        const visible = scene.edges.some(([a, b]) => (a === src && b === tgt) || (a === tgt && b === src));
        return visible ? data : { ...data, hidden: true };
      },
    });

    sigmaRef.current = renderer;
    graphRef.current = graph;

    const goTo = (i: number) => {
      activeSceneRef.current = i;
      setActiveScene(i);
      renderer.refresh();
      // Auto-fit camera around currently-visible nodes
      const scene = scenes[i];
      if (!scene) return;
      const points = scene.nodes
        .filter((id) => graph.hasNode(id))
        .map((id) => ({
          x: graph.getNodeAttribute(id, 'x') as number,
          y: graph.getNodeAttribute(id, 'y') as number,
        }));
      if (points.length === 0) return;
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 4);
      const cam = renderer.getCamera();
      cam.animate(
        { x: 0.5 + cx / 20, y: 0.5 + cy / 20, ratio: Math.max(0.55, Math.min(2.2, span / 8)) },
        { duration: 800, easing: 'quadraticInOut' },
      );
    };

    window.__atlasStory = { sigma: renderer, graph, goTo };

    // Wait one frame for the layout/scroll-trigger to settle, then default to scene 0
    requestAnimationFrame(() => goTo(0));

    return () => {
      renderer.kill();
      graph.clear();
      sigmaRef.current = null;
      graphRef.current = null;
      delete window.__atlasStory;
    };
  }, []);

  // ScrollTrigger setup — one trigger per scene
  useEffect(() => {
    const ctx = gsap.context(() => {
      scenes.forEach((_scene, i) => {
        ScrollTrigger.create({
          trigger: `[data-scene="${i}"]`,
          start: 'top center',
          end: 'bottom center',
          onEnter: () => window.__atlasStory?.goTo(i),
          onEnterBack: () => window.__atlasStory?.goTo(i),
        });
      });
    });
    return () => ctx.revert();
  }, []);

  return (
    <div style={{ background: 'radial-gradient(ellipse at center, #1A1612 0%, #0A0807 70%, #050403 100%)', color: '#F7EDE2', minHeight: '100vh' }}>
      {/* Top nav — minimal, persistent */}
      <header
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'linear-gradient(to bottom, rgba(10,8,7,0.9), rgba(10,8,7,0))',
          zIndex: 50,
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            color: '#C9B79C',
            opacity: 0.85,
            fontFamily: '"Inter", system-ui, sans-serif',
          }}
        >
          Spence Atlas
        </div>
        <a
          href="/explore"
          style={{
            pointerEvents: 'auto',
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: '#C9B79C',
            textDecoration: 'none',
            border: '1px solid rgba(247,237,226,0.12)',
            padding: '7px 14px',
            borderRadius: 4,
            background: 'rgba(10,8,7,0.6)',
            backdropFilter: 'blur(8px)',
            fontFamily: '"Inter", system-ui, sans-serif',
          }}
        >
          Explore the Atlas ›
        </a>
      </header>

      {/* Hero — pre-story landing */}
      <section
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '40px 24px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
            color: '#C9B79C',
            opacity: 0.78,
            marginBottom: 22,
            fontFamily: '"Inter", system-ui, sans-serif',
          }}
        >
          A Spence Atlas Story
        </div>
        <h1
          style={{
            fontSize: isMobile ? 44 : 96,
            fontWeight: 600,
            letterSpacing: '-0.03em',
            lineHeight: 1,
            margin: 0,
            color: '#F7EDE2',
            maxWidth: 900,
          }}
        >
          Tempura isn't&nbsp;Japanese.
        </h1>
        <p
          style={{
            fontSize: isMobile ? 17 : 22,
            color: '#F7EDE2',
            opacity: 0.82,
            maxWidth: 640,
            margin: '32px auto 0',
            lineHeight: 1.55,
            fontFamily: 'Georgia, "Iowan Old Style", "Charter", serif',
            fontStyle: 'italic',
          }}
        >
          How a medieval Catholic fasting rule became a Japanese national dish — and how the
          same Iberian kitchen, a different religion, and the expulsion of 1492 gave Britain
          fish and chips.
        </p>
        <div
          style={{
            marginTop: 64,
            fontSize: 11,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: '#C9B79C',
            opacity: 0.6,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: '"Inter", system-ui, sans-serif',
          }}
        >
          <span style={{ display: 'inline-block', width: 1, height: 24, background: '#C9B79C', opacity: 0.5 }} />
          Scroll
        </div>
      </section>

      {/* Story: pinned graph on one side, scenes scroll past on the other */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1.1fr 1fr',
          gap: 0,
          position: 'relative',
        }}
      >
        {/* PINNED STAGE — graph viz */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            height: '100vh',
            zIndex: 1,
            ...(isMobile
              ? { gridColumn: '1', height: '60vh' }
              : {}),
          }}
        >
          <div
            ref={stageRef}
            style={{
              width: '100%',
              height: '100%',
              background: 'radial-gradient(ellipse at center, #1A1612 0%, #0A0807 80%, #050403 100%)',
            }}
          />
          {/* Caption overlay — only when a scene has caption */}
          {activeScene >= 0 && scenes[activeScene]?.caption && (
            <div
              key={`cap-${activeScene}`}
              style={{
                position: 'absolute',
                bottom: isMobile ? 16 : 36,
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: 11,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: '#C9B79C',
                opacity: 0.82,
                padding: '8px 16px',
                background: 'rgba(10,8,7,0.7)',
                border: '1px solid rgba(247,237,226,0.08)',
                borderRadius: 3,
                backdropFilter: 'blur(8px)',
                fontFamily: '"Inter", system-ui, sans-serif',
                whiteSpace: 'nowrap',
                animation: 'captionPop 480ms cubic-bezier(0.16, 1, 0.3, 1) both',
              }}
            >
              {scenes[activeScene]?.caption}
            </div>
          )}
        </div>

        {/* SCROLLING SCENES — copy column */}
        <div style={{ position: 'relative', zIndex: 2 }}>
          {scenes.map((scene, i) => (
            <SceneBlock key={scene.id} scene={scene} index={i} isMobile={isMobile} />
          ))}
        </div>
      </div>

      {/* CTA — after the reveal */}
      <section
        style={{
          minHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '80px 24px 100px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
            color: '#C9B79C',
            opacity: 0.78,
            marginBottom: 22,
            fontFamily: '"Inter", system-ui, sans-serif',
          }}
        >
          This is one thread
        </div>
        <h2
          style={{
            fontSize: isMobile ? 32 : 56,
            fontWeight: 600,
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
            margin: '0 0 24px',
            color: '#F7EDE2',
            maxWidth: 720,
          }}
        >
          Most dishes have one.
        </h2>
        <p
          style={{
            fontSize: isMobile ? 16 : 19,
            color: '#F7EDE2',
            opacity: 0.82,
            maxWidth: 580,
            margin: '0 auto 36px',
            lineHeight: 1.6,
            fontFamily: 'Georgia, "Iowan Old Style", "Charter", serif',
          }}
        >
          The Meatball Atlas maps forty of them — polpette, kofta, albóndigas, kibbeh,
          köttbullar, bakso, lion&rsquo;s head. Same dish, six trade routes, one ancestor.
          Pull any node to follow its kin.
        </p>
        <a
          href="/explore"
          style={{
            padding: '14px 28px',
            fontSize: 12,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: '#0A0807',
            background: '#F4A23C',
            border: 'none',
            borderRadius: 4,
            textDecoration: 'none',
            fontWeight: 600,
            fontFamily: '"Inter", system-ui, sans-serif',
            cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(244,162,60,0.25)',
          }}
        >
          Enter the Meatball Atlas ›
        </a>
        <div
          style={{
            marginTop: 80,
            paddingTop: 30,
            borderTop: '1px solid rgba(247,237,226,0.08)',
            maxWidth: 640,
            width: '100%',
            fontSize: 12,
            color: '#C9B79C',
            opacity: 0.7,
            lineHeight: 1.7,
            fontFamily: '"Inter", system-ui, sans-serif',
          }}
        >
          <div style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', opacity: 0.85, marginBottom: 12 }}>
            Sources
          </div>
          <div>Katarzyna J. Cwiertka — Modern Japanese Cuisine (Reaktion, 2006)</div>
          <div>Eric C. Rath — Japan's Cuisines: Food, Place and Identity (Reaktion, 2016)</div>
          <div>Alan Davidson — The Oxford Companion to Food</div>
          <div>Claudia Roden — The Book of Jewish Food (Knopf, 1996)</div>
          <div>Panikos Panayi — Fish and Chips: A History (Reaktion, 2014)</div>
        </div>
      </section>
    </div>
  );
}

function SceneBlock({ scene, index, isMobile }: { scene: Scene; index: number; isMobile: boolean }) {
  return (
    <section
      data-scene={index}
      style={{
        minHeight: isMobile ? 'auto' : '100vh',
        padding: isMobile ? '40px 24px 80px' : '14vh 6vw 14vh 5vw',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        maxWidth: 620,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.32em',
          textTransform: 'uppercase',
          color: '#C9B79C',
          opacity: 0.65,
          marginBottom: 14,
          fontFamily: '"Inter", system-ui, sans-serif',
        }}
      >
        Scene {String(index + 1).padStart(2, '0')} of {String(scenes.length).padStart(2, '0')}
      </div>
      <h2
        style={{
          fontSize: isMobile ? 30 : 44,
          fontWeight: 600,
          letterSpacing: '-0.025em',
          lineHeight: 1.08,
          margin: '0 0 22px',
          color: '#F7EDE2',
        }}
      >
        {scene.heading}
      </h2>
      {scene.body.map((p, i) => (
        <p
          key={i}
          style={{
            fontSize: isMobile ? 16 : 19,
            color: '#F7EDE2',
            opacity: 0.86,
            margin: '0 0 18px',
            lineHeight: 1.62,
            fontFamily: 'Georgia, "Iowan Old Style", "Charter", serif',
          }}
        >
          {p}
        </p>
      ))}
    </section>
  );
}
