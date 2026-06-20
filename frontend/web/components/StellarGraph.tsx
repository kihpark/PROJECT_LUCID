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
const EMPTY_SET = new Set<string>();

export interface StellarGraphProps {
  /** Graph payload. Updating swaps the canvas data; the camera is preserved. */
  data: StellarGraphData;
  /** Synthetic mode draws typed-color edges; real mode uses a single accent. */
  mode: 'synthetic' | 'real';
  /** Hover callback (node or null). */
  onNodeHover?: (node: StellarNode | null) => void;
  /** Click callback (full node). */
  onNodeClick?: (node: StellarNode) => void;
  /** B-62-v1 — id of the currently focused node (set by parent on click).
   *  When non-null, distant nodes dim and only focus-incident edges keep
   *  their typed colour. */
  focusedId?: string | null;
  /** B-62-v1 — set of node ids that are 1-hop from `focusedId`. The parent
   *  computes this from the link set once per focus change. */
  focusedNeighborIds?: Set<string>;
}

// B-62-v1 — colour helpers used by the renderer hooks.
//
// `lift` multiplies each channel by `factor` (clamped). Used to lift a base
// cluster colour by the node's validation strength: a 1.0× pixel sits at the
// palette colour; a >1× pixel pushes past it (and past the bloom threshold)
// so well-validated facts visibly glow.
//
// `mixToDim` blends toward a near-background neutral so out-of-focus nodes
// fade without disappearing — the spec says "흐리게", not "invisible".
function lift(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const out = (x: number) => Math.round(clamp(x) * 255).toString(16).padStart(2, '0');
  return `#${out(r * factor)}${out(g * factor)}${out(b * factor)}`;
}
function mixToDim(hex: string, retainedSaturation: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  // Background-leaning neutral with a teal hint so dim nodes still read as
  // "knowledge graph" rather than dead grey.
  const bgR = 0.08;
  const bgG = 0.12;
  const bgB = 0.13;
  const k = retainedSaturation;
  const nr = r * k + bgR * (1 - k);
  const ng = g * k + bgG * (1 - k);
  const nb = b * k + bgB * (1 - k);
  const out = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${out(nr)}${out(ng)}${out(nb)}`;
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
  // B-62-cosmic-tune — starfield re-tuned for "확실한 배경 역할".
  // PO directive: stars should read as a crisp static texture, NOT
  // dissolve into fog when bloom strength rises (we just bumped to
  // 0.5). Recipe:
  //   color   0x2a3540 → 0x3a4858 (luminance 0.18 → 0.27 — visibly
  //           "또렷한" against the #06080b background).
  //   opacity 0.25 → 0.40           (more presence per pixel).
  //   size    0.6 unchanged.
  // Effective brightness ≈ 0.27 × 0.40 = 0.108, still well under the
  // bloom threshold (0.55), so the stars stay as points and do NOT
  // bloom-bleed into surrounding haze. (per PO acceptance ② — "또렷한
  // 정적 배경, bloom 으로 안 번짐".)
  const material = new THREE.PointsMaterial({
    color: 0x3a4858,
    size: 0.6,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  const stars = new THREE.Points(geometry, material);
  stars.name = 'lucid-stellar-starfield';
  scene.add(stars);
  return stars;
}

export function StellarGraph(props: StellarGraphProps) {
  const {
    data,
    mode,
    onNodeHover,
    onNodeClick,
    focusedId = null,
    focusedNeighborIds,
  } = props;
  // Stable identity for the "no focus" case so the callback memo deps don't
  // churn when the parent hasn't sent a set yet.
  const neighborSet = focusedNeighborIds ?? EMPTY_SET;
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
  // B-62-fix-zoom-reset — single-shot guard for handleEngineReady. PO
  // repro: wheel zoom snapped back to ~1.0× within ~150ms. Root cause:
  // the ForceGraph3D `ref` was an INLINE arrow, so React re-evaluated
  // it every render. Every time the wheel-poll `setInterval` below
  // committed a new `zoom` value (which happens whenever the user
  // dollies), React detached the old ref (fgRef ← null) and attached
  // the new one (fgRef ← node, then `if (node) handleEngineReady()`).
  // That re-invocation contained `cameraPosition({z:900})` and reset
  // the camera, erasing the user's dolly. The guard makes the engine-
  // ready setup truly idempotent — it runs once per mount.
  const initializedRef = useRef(false);

  // B-62-fix5 — explicit hover-scale state. Without this the only hover
  // B-62-v1-fix1 — hoveredId state was removed because keeping it caused
  // the nodeSize callback's deps to churn every hover (see nodeSize
  // comment further down). The hover visual now lives only in the parent
  // tooltip; the renderer is hover-agnostic. The parent still gets the
  // hover signal through onNodeHover.

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
  // B-62-fix-zoom-reset — early-return when already initialised so
  // subsequent ref re-attaches (caused by ANY React re-render under
  // the inline ref callback pattern below) do NOT reset the camera or
  // double-add the bloom pass.
  const handleEngineReady = useCallback(() => {
    const handle = fgRef.current;
    if (!handle) return;
    if (initializedRef.current) return;
    initializedRef.current = true;

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
    // B-62-v1 — bloom balanced for "검증된 팩트일수록 빛난다".
    // strength 0.4 sits between fix4's 0.8 (too bright) and fix5's 0.1
    // (too dark). Combined with the `lift()` colour multiplier in
    // `nodeColor`, well-validated facts (validationStrength → 1) push
    // their pixel luminance over threshold 0.5 and bloom; weakly
    // validated facts (vs ~0.35) sit at base palette luminance and stay
    // as sharp points. radius 0.25 keeps the halo tight.
    // B-62-fix-glow-clamp — bloom strength further reduced (0.4 → 0.3)
    // and threshold raised (0.5 → 0.55). PO repro on v1: dense core
    // nodes escalated to pure white during camera moves. With the
    // ACESFilmic tone-mapping added on the renderer below, any residual
    // bloom contribution rolls off softly instead of clipping — so the
    // peaks stay identifiable even under accumulation pressure.
    const composer = handle.postProcessingComposer?.();
    if (composer && typeof composer.addPass === 'function') {
      // B-62-cosmic-tune — strength 0.3 → 0.5. PO directive: nodes
      // should glow more visibly now that ACESFilmic tone mapping +
      // emissive cap + once-only bloom add are in place to prevent
      // whiteout. Threshold 0.55 / radius 0.25 unchanged so the bloom
      // still picks ONLY the high-luminance peaks (well-validated
      // facts), not the dim background or the mid-tone clusters.
      const bloom = new UnrealBloomPass(new THREE.Vector2(1024, 1024), 0.5, 0.25, 0.55);
      composer.addPass(bloom);
      bloomRef.current = bloom as UnrealBloomPass & BloomTargets;
      composerRef.current = composer as unknown as ComposerTargets;
    }
    // Renderer setup — autoClear (existing), pixelRatio (existing), and
    // ACESFilmic tone mapping (NEW in fix-glow-clamp).
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
      // B-62-fix-glow-clamp — ACESFilmic tone mapping. This is the load-
      // bearing fix for PO's "흰색 포화" complaint. Without tone mapping
      // every fragment > 1 in any channel clamps to 1 and we lose detail
      // forever; with ACESFilmic, the curve rolls off so brightness
      // peaks compress into the high-mid range, preserving local
      // contrast even at peak bloom. Exposure 1.0 = neutral; we tune
      // brightness via bloom strength and the lift cap, not exposure.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
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
    function tick() {
      // B-62-cosmic-tune — starfield is now a STATIC background.
      // PO directive: "twinkle/반짝임 애니메이션 완전 제거 — 별의
      // 크기·투명도 per-frame 변동 없애고 고정값". The previous slow
      // y-rotation has been removed; the points sit on a fixed sphere
      // and never move. Combined with the brighter material above
      // this reads as "a confident background texture" rather than
      // "ambient particles".

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
  // B-62-cosmic-tune — starfield is now visible in BOTH modes. fix4
  // hid it on REAL to avoid the "fake galaxy" reading when only 5
  // facts existed; now that B-62-real-all-facts surfaces every fact
  // AND the starfield itself is a static, dim background texture
  // (no rotation, no twinkle, well below the bloom threshold), the
  // PO directive is to show stars in both modes as a "확실한 배경
  // 역할". Identity of synthetic vs real is carried by the data
  // (node count, cluster colour palette), not by the background.
  useEffect(() => {
    const stars = starsRef.current;
    if (!stars) return;
    stars.visible = true;
  }, [mode]);

  // B-62-fix-glow-clamp — keep the zoom readout in sync with the actual
  // camera distance. The +/- buttons drive this directly via applyZoom,
  // but the user can ALSO zoom with the mouse wheel (OrbitControls dolly)
  // — that bypasses applyZoom, so the displayed scale stayed stuck. We
  // poll the camera at 150ms (≈ 6Hz, fast enough to feel live, slow
  // enough to avoid spamming setState during autoRotate). Only commits
  // when the change exceeds 2% so React doesn't re-render every tick.
  useEffect(() => {
    const id = window.setInterval(() => {
      const camera = fgRef.current?.camera?.();
      if (!camera) return;
      const dist = camera.position.length();
      if (!Number.isFinite(dist) || dist < 1) return;
      const actualZoom = INITIAL_DIST / dist;
      setZoom((prev) => (Math.abs(actualZoom - prev) > 0.02 ? actualZoom : prev));
    }, 150);
    return () => window.clearInterval(id);
  }, []);

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

  // B-62-v1 — link colour reflects edge TYPE (synthetic) or the single
  // accent (real). Focus mode adds a second layer: edges incident on the
  // focused node keep their typed colour; the rest fade to near-invisible
  // so the focal subgraph reads cleanly.
  const linkColor = useCallback(
    (link: StellarLink): string => {
      const baseColor =
        mode === 'real'
          ? 'rgba(63,224,198,0.55)'
          : EDGE_COLORS[link.type] ?? 'rgba(255,255,255,0.35)';
      if (focusedId === null) return baseColor;
      // ForceGraph3D mutates link.source/target to node objects after the
      // simulation runs. Handle both shapes.
      const src =
        typeof link.source === 'string'
          ? link.source
          : (link.source as { id?: string } | null)?.id ?? '';
      const tgt =
        typeof link.target === 'string'
          ? link.target
          : (link.target as { id?: string } | null)?.id ?? '';
      const incident = src === focusedId || tgt === focusedId;
      return incident ? baseColor : 'rgba(45,55,65,0.06)';
    },
    [mode, focusedId],
  );

  // B-62-v1 — node colour composes three signals:
  //   1. cluster palette (which subject group this fact belongs to).
  //   2. validation strength — the colour is multiplied by (0.6 + vs * 0.5)
  //      so well-validated facts push past the bloom threshold and glow,
  //      while thin facts stay as sharp but un-bloomed points.
  //   3. focus dim — when the user has focused a node, distant nodes
  //      blend toward the dark background so the 1-hop subgraph stands out.
  // B-62-fix-glow-clamp — emissive lift now CAPPED.
  // Previous (v1): `lift(base, 0.6 + vs * 0.5)` → max factor 1.1, which
  // pushed luminance peaks above 1.0 and clipped to white once the bloom
  // pass added on top. New formula: `min(0.95, 0.5 + vs * 0.35)` → max
  // factor 0.85 for a fully validated fact. The cluster colour stays the
  // dominant signal; the validation channel just brightens it modestly.
  // Combined with ACESFilmic tone mapping, no single pixel can saturate
  // to (1,1,1) — peaks roll off, peaks stay identifiable.
  const nodeColor = useCallback(
    (node: StellarNode): string => {
      const base =
        CLUSTER_PALETTE[(node.cluster ?? 0) % CLUSTER_PALETTE.length] ?? ACCENT;
      const vs = node.validationStrength ?? 0.5;
      const factor = Math.min(0.95, 0.5 + vs * 0.35);
      const lifted = lift(base, factor);
      if (focusedId === null) return lifted;
      // Focused: slightly brighter than its neighbours, but still capped
      // so the focal node never blows out under bloom.
      if (focusedId === node.id) return lift(base, Math.min(1.0, factor + 0.1));
      if (neighborSet.has(node.id)) return lifted;
      return mixToDim(lifted, 0.18);
    },
    [focusedId, neighborSet],
  );

  // B-62-v1-fix1 — node size derives from graph degree only. Hover scale
  // is REMOVED from this callback path.
  //
  // PO repro: hovering different nodes made the entire canvas "zoom in"
  // continuously. Root cause: this callback's dep list included
  // `hoveredId`, so the function reference churned every hover. The
  // underlying react-force-graph-3d wrapper treats nodeVal as a stable
  // signal — when its reference changes, three.js re-feeds the d3-force
  // simulation. Each reheat re-spreads the cluster slightly outward
  // while the camera holds, producing the apparent zoom-in.
  //
  // The hover visual now lives entirely in the cursor tooltip (HoverTooltip
  // in StellarView), which matches the v1 spec "hover = 가벼운 미리보기".
  // Focus signals stay in the deps — focus changes are rare and
  // intentional (click only), so the reheat there is acceptable and
  // actually helps re-balance the focal subgraph.
  const nodeSize = useCallback(
    (node: StellarNode): number => {
      const importance = node.degree ?? node.weight ?? 1;
      const base = 0.9 + Math.sqrt(importance);
      let scale = 1;
      if (focusedId === node.id) scale = 1.6;
      else if (focusedId !== null && neighborSet.has(node.id)) scale = 1.25;
      return base * scale;
    },
    [focusedId, neighborSet],
  );

  // B-62-v1-fix1 — straight forward to the parent. We no longer hold a
  // local hover id; the renderer is hover-agnostic and only StellarView's
  // HoverTooltip reacts to onNodeHover events.
  const handleHoverInternal = onNodeHover ?? undefined;

  // Tooltip text — react-force-graph reads `nodeLabel` to render the default
  // hover hint. Our parent component overlays a richer tooltip on top.
  const labelOf = useCallback((node: StellarNode): string => node.label, []);

  // B-62-fix-zoom-reset — stable ref callback. Even with the
  // single-shot guard inside handleEngineReady, an inline arrow as
  // `ref={...}` makes React detach/attach the ref every render, which
  // briefly sets `fgRef.current = null`. That null window broke the
  // wheel-poll interval (it sees no camera for one tick) and triggered
  // visual flicker in the focus subgraph. Memoising the callback
  // eliminates the detach/attach churn entirely.
  const attachRef = useCallback(
    (node: unknown) => {
      fgRef.current = node as ForceGraphRefHandle | null;
      if (node) handleEngineReady();
    },
    [handleEngineReady],
  );

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
          ref={attachRef}
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
          onNodeHover={handleHoverInternal}
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
          /* B-62-v1-fix1 — viewport-fixed positioning (was absolute
           * inside the graph container). PO repro: still invisible
           * after fix5's z-index 1000 lift — the dynamic-imported
           * ForceGraph3D wrapper creates its own stacking context that
           * the parent's absolute child can't reliably escape. `fixed`
           * leaves the entire stacking-context graph and pins to the
           * viewport. z-index lifted further (1000 → 10000) so even
           * AppShell ribbons and any modal-portal layers cannot cover
           * it. Visually identical to before — same right:20, bottom:20. */
          position: 'fixed',
          right: 20,
          bottom: 20,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 4,
          padding: 6,
          background: 'rgba(13,20,23,0.92)',
          border: '1px solid #1d2b2f',
          borderRadius: 12,
          backdropFilter: 'blur(8px)',
          fontFamily: 'JetBrains Mono, monospace',
          color: '#cdd9da',
          fontSize: 12,
          zIndex: 10000,
          userSelect: 'none',
          boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
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
