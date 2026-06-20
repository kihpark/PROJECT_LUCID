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
  // B-62-fix2 — added for bloom-accumulation defeat. We need the renderer
  // to wipe UnrealBloomPass's ping-pong targets every frame.
  renderer?: () => THREE.WebGLRenderer;
  cameraPosition?: (
    pos: { x: number; y: number; z: number },
    lookAt?: { x: number; y: number; z: number } | null,
    duration?: number,
  ) => void;
}

// B-62-fix2 — UnrealBloomPass exposes the ping-pong target arrays we need
// to clear each frame. Three's typings don't expose these on the base
// Pass class, so we narrow with our own structural type.
interface BloomTargets {
  renderTargetsHorizontal?: THREE.WebGLRenderTarget[];
  renderTargetsVertical?: THREE.WebGLRenderTarget[];
}

// B-62-fix3 — EffectComposer exposes its primary ping-pong pair as
// renderTarget1 / renderTarget2. Clearing these is a secondary defense
// against bloom accumulation if the bloom pass's own targets stay stuck.
interface ComposerTargets {
  renderTarget1?: THREE.WebGLRenderTarget;
  renderTarget2?: THREE.WebGLRenderTarget;
  addPass: (pass: unknown) => void;
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
  // B-62-fix3 — starfield further dimmed so it cannot meaningfully
  // contribute to bloom even if the per-frame buffer clear silently
  // no-ops. PO repro on fix2 showed full whiteout in SYNTHETIC (2000
  // nodes) — high node density means even a moderate bloom contribution
  // per pixel adds up across the canvas. Effective brightness now sits
  // at color (luminance ~0.18) × opacity 0.25 ≈ 0.045, far under the
  // bloom threshold (0.5), so the starfield is unconditionally exempt.
  const material = new THREE.PointsMaterial({
    color: 0x2a3540,
    size: 0.6,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.25,
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
  // B-62-fix2/fix3 — references held so the per-frame tick can clear
  // both the bloom pass's ping-pong buffers AND the EffectComposer's
  // primary ping-pong pair (defeats brightness accumulation that made
  // nodes "appear to grow" and the starfield bleed into noise).
  const bloomRef = useRef<(UnrealBloomPass & BloomTargets) | null>(null);
  const composerRef = useRef<ComposerTargets | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  // B-62-fix4 — zoom controller state. 1.0 = initial camera distance
  // (900 in scene units). >1 = closer, <1 = farther. Clamped to [0.25, 4]
  // so the user can't dolly past the cluster or out into the starfield.
  const [zoom, setZoom] = useState(1.0);
  const INITIAL_DIST = 900;

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

    // B-62-fix2 — bloom tuning + reference capture.
    //
    // Previous (fix1): strength 1.7, radius 0.55, threshold 0.15. PO
    // dogfood found nodes apparently growing over time and starfield
    // glowing as noise. Root cause (PO's hypothesis, confirmed by the
    // tick-loop clear below): UnrealBloomPass's internal ping-pong
    // render targets were not being cleared each frame, so each frame's
    // bloom contribution layered on top of the previous one — perceived
    // as steady brightness inflation across the whole canvas.
    //
    // Tuning:
    //   strength  1.7 → 1.2  — still glows the teal/cyan/mint nodes
    //                          (luminance ~0.7) but stops the canvas-
    //                          wide halo wash.
    //   radius    0.55 → 0.5 — slightly tighter spread.
    //   threshold 0.15 → 0.4 — pixels below luminance 0.4 are exempt
    //                          from bloom entirely. The dimmed starfield
    //                          (color 0x506070 ≈ luminance 0.36 × opacity
    //                          0.4) sits comfortably below the line, so
    //                          stars are now points, not torches.
    // B-62-fix3 — bloom dramatically softened + composer reference.
    //
    // fix2 set strength 1.2, threshold 0.4. PO repro: SYNTHETIC (2000
    // nodes) was immediate whiteout; REAL (5 nodes) was bearable. The
    // density-dependent failure confirms the bloom contribution per
    // pixel was still too high — and we couldn't rely on the per-frame
    // bloom-target clear because the ForceGraphRefHandle from
    // react-force-graph-3d does NOT expose `.renderer()`, so the clear
    // loop was a silent no-op. fix3 attacks the magnitude instead:
    //   strength  1.2 → 0.6  — half. Nodes still glow but a single frame
    //                          of bloom contribution is sub-perceptible
    //                          on dense clusters.
    //   radius    0.5 → 0.4  — tighter halo, less spread into adjacent
    //                          pixels.
    //   threshold 0.4 → 0.6  — pixels below luminance 0.6 are exempt,
    //                          which now includes mid-tone teal pixels;
    //                          only the brightest peaks bloom.
    //
    // We also capture the composer reference itself so the tick can
    // clear composer.renderTarget1/2 (these DO live on the composer
    // object) — that's the secondary line of defense if the bloom
    // ping-pong targets stay stuck for any reason.
    // B-62-fix4 — bloom balance: stars sharp, not blurry blobs.
    // fix3 dropped strength to 0.6 / radius 0.4 / threshold 0.6 to defeat
    // whiteout. PO acceptance: stars now visible but they read as fuzzy
    // halos rather than sharp points. Raise strength slightly (0.6 → 0.8
    // matches PO's "~0.8" target) and crush the radius (0.4 → 0.25) so
    // bloom contributes a tight glow around each node instead of a wide
    // blur. Threshold relaxed 0.6 → 0.55 to keep mid-tone teal nodes
    // genuinely bright, not anaemic.
    const composer = handle.postProcessingComposer?.();
    if (composer && typeof composer.addPass === 'function') {
      const bloom = new UnrealBloomPass(new THREE.Vector2(1024, 1024), 0.8, 0.25, 0.55);
      composer.addPass(bloom);
      bloomRef.current = bloom as UnrealBloomPass & BloomTargets;
      composerRef.current = composer as unknown as ComposerTargets;
    }
    // Renderer reference for the per-frame buffer clear, the auto-clear
    // guarantee, and the fix4 pixelRatio bump.
    const renderer = handle.renderer?.();
    if (renderer) {
      renderer.autoClear = true;
      renderer.autoClearColor = true;
      renderer.autoClearDepth = true;
      // B-62-fix4 — honour the device pixel ratio so high-DPI displays
      // render the canvas at native resolution. The default ratio (1)
      // makes individual node pixels visibly soft on retina/4K panels.
      // Cap at 2 so we don't pay for 3× supersampling on phones.
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
      renderer.setPixelRatio(Math.min(dpr, 2));
      rendererRef.current = renderer;
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

  // Per-frame tick. Two duties:
  //   (a) drift the starfield (very slow y-rotation),
  //   (b) B-62-fix2: clear UnrealBloomPass's ping-pong render targets so
  //       each frame's bloom doesn't accumulate on top of the previous
  //       one — without this the canvas brightness drifts upward forever
  //       (PO repro: nodes "growing", starfield turning into a glowing
  //       noise floor). UnrealBloomPass renders its blur into two pairs
  //       of ping-pong targets per mip level; clearing them at frame
  //       start forces the pass to start from black every time.
  useEffect(() => {
    let cancelled = false;
    let last = performance.now();
    function tick(now: number) {
      const dt = (now - last) / 1000;
      last = now;
      const stars = starsRef.current;
      if (stars) stars.rotation.y += dt * 0.012; // very slow drift

      // Clear every render target that could be holding stale bloom:
      //   1. UnrealBloomPass's per-mip ping-pong pairs (renderTargets-
      //      Horizontal / Vertical),
      //   2. EffectComposer's primary pair (renderTarget1 / renderTarget2)
      //      — this is the fix3 secondary defense.
      // If the ref API doesn't expose .renderer() on this build of
      // react-force-graph-3d, rendererRef.current stays null and this
      // block is a no-op (the magnitude reductions in handleEngineReady
      // are the load-bearing fix in that case).
      const renderer = rendererRef.current;
      const bloom = bloomRef.current;
      const composer = composerRef.current;
      if (renderer && (bloom || composer)) {
        const prevTarget = renderer.getRenderTarget();
        if (bloom) {
          for (const t of bloom.renderTargetsHorizontal ?? []) {
            renderer.setRenderTarget(t);
            renderer.clear(true, true, true);
          }
          for (const t of bloom.renderTargetsVertical ?? []) {
            renderer.setRenderTarget(t);
            renderer.clear(true, true, true);
          }
        }
        if (composer) {
          if (composer.renderTarget1) {
            renderer.setRenderTarget(composer.renderTarget1);
            renderer.clear(true, true, true);
          }
          if (composer.renderTarget2) {
            renderer.setRenderTarget(composer.renderTarget2);
            renderer.clear(true, true, true);
          }
        }
        renderer.setRenderTarget(prevTarget);
      }

      if (!cancelled) requestAnimationFrame(tick);
    }
    const handle = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, []);

  // B-62-fix4 — starfield visibility tracks mode.
  // PO directive: REAL mode must NOT use the synthetic starfield as
  // backdrop ("실데이터가 가짜 은하처럼 보이면 안 됨"). In SYNTHETIC the
  // sparse field reads as cosmic dust behind the galaxy; in REAL it
  // would read as fake stars padding out a 5-node graph. Hide it.
  useEffect(() => {
    const stars = starsRef.current;
    if (!stars) return;
    stars.visible = mode === 'synthetic';
  }, [mode]);

  // B-62-fix4 — imperative zoom step. Reads the current camera
  // direction from the live ref so it composes correctly with autoRotate
  // and user orbit; only the distance along the eye→origin axis changes.
  const applyZoom = useCallback((nextZoom: number) => {
    const clamped = Math.max(0.25, Math.min(4, nextZoom));
    setZoom(clamped);
    const handle = fgRef.current;
    const camera = handle?.camera?.();
    if (!camera || !handle?.cameraPosition) return;
    const dir = camera.position.clone();
    if (dir.lengthSq() === 0) dir.set(0, 0, 1);
    dir.normalize();
    const newDist = INITIAL_DIST / clamped;
    const target = dir.multiplyScalar(newDist);
    handle.cameraPosition(
      { x: target.x, y: target.y, z: target.z },
      { x: 0, y: 0, z: 0 },
      250,
    );
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
          /* B-62-fix3 — small reductions across the lighting surfaces
           * so SYNTHETIC density (2000 nodes) does not pile per-pixel
           * bloom contributions into whiteout: node opacity slightly
           * down from 0.95 → 0.88, link particles disabled (each
           * particle is a bright dot that bloom catches; killing them
           * removes an entire category of point lights). */
          nodeOpacity={0.88}
          nodeResolution={12}
          linkColor={linkColor}
          linkOpacity={mode === 'real' ? 0.4 : 0.5}
          linkWidth={0.6}
          linkDirectionalParticles={0}
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleWidth={1.1}
          enableNodeDrag={false}
          showNavInfo={false}
          onNodeHover={onNodeHover}
          onNodeClick={onNodeClick}
          /* B-62-fix2 — let the d3-force simulation settle after ~300
           * ticks so node positions stop drifting. PO repro showed nodes
           * appearing to slowly grow even after the bloom-accumulation
           * fix; the residual movement was the simulation continuing to
           * compress clusters indefinitely. The velocity decay raise
           * (0.4 default → 0.55) shortens the settle without changing
           * the equilibrium layout. */
          cooldownTicks={300}
          d3VelocityDecay={0.55}
        />
      ) : null}
      {/* B-62-fix4 — bottom-right zoom controller. Three rows: + / scale /
       *  −. Buttons step by 1.25× / 0.8× (factor matches camera dolly
       *  feel). Disabled at the clamp ends. Scale shown to 2 decimals. */}
      <div
        data-testid="stellar-zoom-controls"
        style={{
          position: 'absolute',
          right: 20,
          bottom: 20,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 4,
          padding: 6,
          background: 'rgba(13,20,23,0.78)',
          border: '1px solid #1d2b2f',
          borderRadius: 12,
          backdropFilter: 'blur(8px)',
          fontFamily: 'JetBrains Mono, monospace',
          color: '#cdd9da',
          fontSize: 12,
          zIndex: 5,
          userSelect: 'none',
        }}
      >
        <button
          type="button"
          data-testid="stellar-zoom-in"
          aria-label="zoom in"
          disabled={zoom >= 4}
          onClick={() => applyZoom(zoom * 1.25)}
          style={{
            width: 36,
            height: 28,
            borderRadius: 7,
            background: zoom >= 4 ? '#0d1417' : '#102023',
            border: '1px solid #1d2b2f',
            color: '#3fe0c6',
            fontWeight: 600,
            cursor: zoom >= 4 ? 'not-allowed' : 'pointer',
            opacity: zoom >= 4 ? 0.4 : 1,
          }}
        >
          +
        </button>
        <div
          data-testid="stellar-zoom-scale"
          style={{
            textAlign: 'center',
            padding: '2px 0',
            color: '#9db0b5',
            letterSpacing: '0.04em',
          }}
        >
          {zoom.toFixed(2)}x
        </div>
        <button
          type="button"
          data-testid="stellar-zoom-out"
          aria-label="zoom out"
          disabled={zoom <= 0.25}
          onClick={() => applyZoom(zoom * 0.8)}
          style={{
            width: 36,
            height: 28,
            borderRadius: 7,
            background: zoom <= 0.25 ? '#0d1417' : '#102023',
            border: '1px solid #1d2b2f',
            color: '#3fe0c6',
            fontWeight: 600,
            cursor: zoom <= 0.25 ? 'not-allowed' : 'pointer',
            opacity: zoom <= 0.25 ? 0.4 : 1,
          }}
        >
          −
        </button>
      </div>
    </div>
  );
}

export default StellarGraph;
