/**
 * B-62 — StellarGraph: the 3D renderer wrapper.
 *
 * Isolation contract: this is the ONLY file that imports
 * `react-force-graph-3d` and `three`. The page shell (`StellarView`) can
 * be swapped to a different renderer without touching the data model.
 *
 * Recipe (per the brief):
 *   - Engine: react-force-graph-3d (production-grade three.js wrapper).
 *   - Bloom: UnrealBloomPass via EffectComposer
 *     strength 1.7, radius 0.55, threshold 0.15.
 *   - Background: pure black (#000) for max bloom contrast.
 *   - Starfield: ~4000 inert dots on a large invisible sphere, slow rotation.
 *   - Nodes: size ∝ weight (source-count analogue), color by cluster.
 *   - Edges: typed colors for synthetic / single accent for real.
 *   - Camera: orbit + damping + slow autoRotate when idle.
 *
 * Tests do NOT exercise this file — vitest jsdom can't render canvas.
 * The page component (`StellarView`) wraps it via dynamic-import so SSR
 * does not try to mount three.js on the Node side.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {
  CLUSTER_PALETTE,
  EDGE_COLORS,
  type StellarGraphData,
  type StellarLink,
  type StellarNode,
} from '@/lib/syntheticGraph';

// react-force-graph-3d is a client-only module. Importing it directly from
// page code makes Next try to evaluate three.js on the server at build time
// and explode. Dynamic import + ssr:false is the canonical fix.
//
// The library's typings are written against a particular NodeObject shape
// (id?: string | number, …) that doesn't agree with our augmented StellarNode
// once we attach `cluster`, `weight`, `subject`, etc. Rather than fight the
// typings on every prop, we cast the lazy component to a permissive
// signature; the runtime contract is exercised by the smoke + visual check.
const ForceGraph3DLazy = dynamic(() => import('react-force-graph-3d'), {
  ssr: false,
  loading: () => (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#000',
        color: '#3fe0c6',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
      }}
    >
      별자리 점화 중…
    </div>
  ),
});
const ForceGraph3D = ForceGraph3DLazy as unknown as React.ComponentType<Record<string, unknown>>;

const ACCENT = '#3fe0c6';

export interface StellarGraphProps {
  /** Graph payload. Updating swaps the canvas data; the camera is preserved. */
  data: StellarGraphData;
  /** Synthetic mode draws typed-color edges; real mode uses a single accent. */
  mode: 'synthetic' | 'real';
  /** Hover callback (node or null). */
  onNodeHover?: (node: StellarNode | null) => void;
  /** Click callback (full node). */
  onNodeClick?: (node: StellarNode) => void;
}

interface ForceGraphRefHandle {
  postProcessingComposer?: () => { addPass: (pass: unknown) => void } | undefined;
  scene?: () => THREE.Scene;
  camera?: () => THREE.PerspectiveCamera;
  controls?: () => {
    autoRotate?: boolean;
    autoRotateSpeed?: number;
    enableDamping?: boolean;
    dampingFactor?: number;
  };
  cameraPosition?: (
    pos: { x: number; y: number; z: number },
    lookAt?: { x: number; y: number; z: number } | null,
    duration?: number,
  ) => void;
}

/** Add a slow-rotating starfield behind the graph. The dots are tiny so the
 *  bloom pass doesn't bleed them; the rotation gives the "우주감" without
 *  flooding the eye. */
function attachStarfield(scene: THREE.Scene): THREE.Points {
  const count = 4000;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  // Place each point on a large sphere (radius 4500) — far behind the
  // graph (which sits inside ~600 unit cube), so it never occludes nodes.
  const RADIUS = 4500;
  for (let i = 0; i < count; i += 1) {
    // Uniform on a sphere: pick u ∈ [-1,1], θ ∈ [0,2π).
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * 2 * Math.PI;
    const r = Math.sqrt(1 - u * u);
    positions[i * 3 + 0] = Math.cos(theta) * r * RADIUS;
    positions[i * 3 + 1] = u * RADIUS;
    positions[i * 3 + 2] = Math.sin(theta) * r * RADIUS;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.4,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const stars = new THREE.Points(geometry, material);
  stars.name = 'lucid-stellar-starfield';
  scene.add(stars);
  return stars;
}

export function StellarGraph(props: StellarGraphProps) {
  const { data, mode, onNodeHover, onNodeClick } = props;
  const fgRef = useRef<ForceGraphRefHandle | null>(null);
  const starsRef = useRef<THREE.Points | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Observe container size so the canvas fills the parent fullscreen layout.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      const rect = node.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(node);
    const rect = node.getBoundingClientRect();
    setSize({ w: rect.width, h: rect.height });
    return () => ro.disconnect();
  }, []);

  // One-time scene wiring: bloom pass + starfield + camera config.
  const handleEngineReady = useCallback(() => {
    const handle = fgRef.current;
    if (!handle) return;

    // Bloom pass via the built-in postprocessing hook.
    const composer = handle.postProcessingComposer?.();
    if (composer && typeof composer.addPass === 'function') {
      // strength 1.7, radius 0.55, threshold 0.15 — tuned to "stars glow,
      // not bleed". The resolution arg is fed by EffectComposer when we
      // hand the pass off, so the constructor's Vector2 is fine.
      const bloom = new UnrealBloomPass(new THREE.Vector2(1024, 1024), 1.7, 0.55, 0.15);
      composer.addPass(bloom);
    }

    // Dark cosmic background + starfield.
    //
    // B-62-fix1 — the ForceGraph3D `backgroundColor` prop is set, but with
    // UnrealBloomPass mounted on the composer the clear color reverts to
    // white at the first frame (the bloom pass's intermediate buffer was
    // running over the renderer's clear). A non-zero clear that high
    // (1,1,1 ≫ threshold 0.15) made the bloom flare the entire canvas to
    // whiteout. Setting `scene.background` directly bypasses the prop path
    // and forces the dark colour onto the scene the bloom pass actually
    // sees — verified by PO (white screen → galaxy on dark canvas).
    const scene = handle.scene?.();
    if (scene) {
      scene.background = new THREE.Color(0x06080b);
      if (!starsRef.current) {
        starsRef.current = attachStarfield(scene);
      }
    }

    // Camera + controls: narrow FOV, autoRotate slow, damping on.
    const camera = handle.camera?.();
    if (camera) {
      camera.fov = 45;
      camera.updateProjectionMatrix();
    }
    const controls = handle.controls?.();
    if (controls) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.25; // ~0.3 deg/s feel
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
    }

    // Initial camera pull-back so the user sees the whole galaxy on first paint.
    handle.cameraPosition?.({ x: 0, y: 0, z: 900 }, { x: 0, y: 0, z: 0 }, 0);
  }, []);

  // Slowly rotate the starfield. We rely on react-force-graph-3d's per-frame
  // render loop; setting userData on the field lets the engine pick it up via
  // onSatelliteRotate. Simplest: tick via requestAnimationFrame loop.
  useEffect(() => {
    let cancelled = false;
    let last = performance.now();
    function tick(now: number) {
      const dt = (now - last) / 1000;
      last = now;
      const stars = starsRef.current;
      if (stars) stars.rotation.y += dt * 0.012; // very slow drift
      if (!cancelled) requestAnimationFrame(tick);
    }
    const handle = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, []);

  const linkColor = useCallback(
    (link: StellarLink): string => {
      if (mode === 'real') return 'rgba(63,224,198,0.55)';
      return EDGE_COLORS[link.type] ?? 'rgba(255,255,255,0.35)';
    },
    [mode],
  );

  const nodeColor = useCallback((node: StellarNode): string => {
    const c = node.cluster ?? 0;
    return CLUSTER_PALETTE[c % CLUSTER_PALETTE.length] ?? ACCENT;
  }, []);

  const nodeSize = useCallback((node: StellarNode): number => {
    return 1.2 + Math.sqrt(node.weight ?? 1);
  }, []);

  // Tooltip text — react-force-graph reads `nodeLabel` to render the default
  // hover hint. Our parent component overlays a richer tooltip on top.
  const labelOf = useCallback((node: StellarNode): string => node.label, []);

  // The component is too tall to be useful without an explicit height — fill parent.
  return (
    <div
      ref={containerRef}
      data-testid="stellar-graph-root"
      data-mode={mode}
      style={{
        position: 'absolute',
        inset: 0,
        background: '#000',
        overflow: 'hidden',
      }}
    >
      {size.w > 0 && size.h > 0 ? (
        <ForceGraph3D
          ref={(node: unknown) => {
            fgRef.current = node as ForceGraphRefHandle | null;
            if (node) handleEngineReady();
          }}
          graphData={data}
          width={size.w}
          height={size.h}
          backgroundColor="#06080b"
          nodeId="id"
          nodeLabel={labelOf}
          nodeColor={nodeColor}
          nodeVal={nodeSize}
          nodeOpacity={0.95}
          nodeResolution={12}
          linkColor={linkColor}
          linkOpacity={mode === 'real' ? 0.4 : 0.55}
          linkWidth={0.6}
          linkDirectionalParticles={mode === 'synthetic' ? 1 : 0}
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleWidth={1.1}
          enableNodeDrag={false}
          showNavInfo={false}
          onNodeHover={onNodeHover}
          onNodeClick={onNodeClick}
        />
      ) : null}
    </div>
  );
}

export default StellarGraph;
