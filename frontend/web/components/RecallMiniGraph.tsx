'use client';

/**
 * ★ REQ-011-v1 (★ PO 2026-06-30) — Recall 근거 미니 그래프.
 *
 * 시안 verbatim 의 캔버스 로직 (참고_Lucid Recall 리디자인.dc.html §drawGraph)
 * 을 React + Canvas 2D 패턴으로 재구현. 외부 라이브러리 0.
 *
 * 의뢰서 §4-4-(우) verbatim:
 *   "<canvas> 노드-링크 시각화 (중앙=질의 대상, 주변=목적어 노드,
 *    엣지 라벨=관계). 커서 호버 시 노드/엣지 하이라이트, 은은한 펄스."
 *
 * 의뢰서 §10 verbatim:
 *   "Canvas 2D. 중앙 노드(대상) + N개 목적어 노드를 각도 분배로 원형 배치.
 *    엣지 stroke + 중점에 관계 라벨(mono). 노드 = 채운 원 + 글로우.
 *    호버: 포인터-노드 거리 판정으로 하이라이트(엣지/노드 밝기↑).
 *    은은한 sin 펄스. requestAnimationFrame, DPR 캡 1.6, 60fps.
 *    리마운트(상태 전환) 대비: 매 프레임 clientWidth 변화 감지 시
 *    캔버스 백킹 사이즈 재계산."
 *
 * 의뢰서 §4-(Stellar 와의 관계) verbatim:
 *   "근거 그래프는 답 1개의 출처만 보여주는 수렴형·읽기전용 미니뷰.
 *    Stellar 수준의 인터랙션을 넣지 말 것."
 */

import { useEffect, useRef, useState } from 'react';
import type { RecallExampleGraphNode } from '@/lib/recall-history';

interface Props {
  center: string;
  nodes: RecallExampleGraphNode[];
  height?: number;
}

/**
 * ★ REQ-014-F (PO 2026-07-02) — 라벨 겹침 정리.
 *
 * PO 지적 verbatim: "라벨들이 서로 겹침 (outlined plans to strengthen…,
 *   is accelerating development of, reaffirmed…) — 저게 맞아?"
 *
 * 원인: edge predicate 라벨을 모두 edge midpoint 에 그리다 보니,
 *   중심에서 방사되는 여러 edge 의 midpoint 가 서로 가까워 겹침. 또한
 *   자연어 predicate 는 길이가 길어 (10-40 char) 서로 침범.
 *
 * 처방 (PO 권장 A + hover full text):
 *   1. 그린 label 은 `truncate(edge, 14)` — 넘치면 "…" 붙임
 *   2. midpoint 를 노드 방향으로 62% 이동 — 중심 근처 클러스터 회피
 *   3. hover 시 해당 edge/노드는 full text 로 강조 (상시)
 *   4. 노드 라벨도 `truncate(label, 12)` — 화면 밖 튀는 것 방지
 *
 * Canvas fillText 는 이미 라벨 hover 시 fully readable (밝은 색) 이므로
 *   툴팁을 추가로 얹지 않는다 — 캔버스만 유지 (컴포넌트 단순함 유지).
 */
function truncateLabel(s: string, max: number): string {
  if (!s) return s;
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '…';
}

export function RecallMiniGraph({
  center,
  nodes,
  height = 286,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ptrRef = useRef({ x: -999, y: -999 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef<number | null>(null);
  // hover state exposed to DOM so e2e / a11y 툴이 볼 수 있다.
  const [hoverIdx, setHoverIdx] = useState<number>(-2);
  const hoverRef = useRef<number>(-2);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const dpr = Math.min(1.6, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || 440;
      const h = canvas.clientHeight || height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w, h };
    };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ptrRef.current.x = e.clientX - r.left;
      ptrRef.current.y = e.clientY - r.top;
    };
    const onLeave = () => {
      ptrRef.current.x = -999;
      ptrRef.current.y = -999;
    };
    const onResize = () => resize();

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', onResize);
    resize();

    const N = nodes.length;
    const draw = (t: number) => {
      // 시안 verbatim — clientWidth 변화 감지 시 재계산.
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw > 0 && (cw !== sizeRef.current.w || ch !== sizeRef.current.h)) {
        resize();
      }
      const { w, h } = sizeRef.current;
      if (!w || !h) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      ctx.clearRect(0, 0, w, h);
      const cx = w * 0.5;
      const cy = h * 0.46;
      const R = Math.min(w, h) * 0.30;

      // positions — 시안 verbatim.
      const pts = nodes.map((n, i) => {
        const a = -Math.PI / 2 + (i / N) * Math.PI * 2 + 0.3;
        return {
          x: cx + Math.cos(a) * R,
          y: cy + Math.sin(a) * R * 0.86,
          label: n.label,
          edge: n.edge,
        };
      });

      // hover detection.
      let hover = -2;
      if (Math.hypot(ptrRef.current.x - cx, ptrRef.current.y - cy) < 30) {
        hover = -1;
      }
      pts.forEach((p, i) => {
        if (Math.hypot(ptrRef.current.x - p.x, ptrRef.current.y - p.y) < 30) {
          hover = i;
        }
      });
      // hover state → DOM (aria-hidden 내부; e2e 훅용).
      if (hover !== hoverRef.current) {
        hoverRef.current = hover;
        setHoverIdx(hover);
      }

      // edges.
      // ★ REQ-014-F: predicate 라벨 midpoint 이동 (중심→노드 방향 62%)
      //   + truncate(14). 여러 edge 의 midpoint 가 중심 부근에 몰려
      //   겹치던 문제 회피. hover 시 full text.
      ctx.lineWidth = 1.2;
      pts.forEach((p, i) => {
        const on = hover === i || hover === -1;
        ctx.strokeStyle = on
          ? 'rgba(45,212,191,0.65)'
          : 'rgba(45,212,191,0.22)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        // predicate label — 노드 쪽으로 62% 이동 (중심 클러스터 회피).
        const t = 0.62;
        const mx = cx + (p.x - cx) * t;
        const my = cy + (p.y - cy) * t;
        ctx.font = on
          ? "600 10.5px 'JetBrains Mono', monospace"
          : "10px 'JetBrains Mono', monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = on
          ? 'rgba(150,240,225,0.95)'
          : 'rgba(120,200,188,0.55)';
        // hover 는 full, 아니면 14 char 로 자름.
        const shownEdge = on ? p.edge : truncateLabel(p.edge, 14);
        // 배경 shadow (hover 시 가독성) — 캔버스 위에 얇은 dim 박스.
        if (on) {
          const metrics = ctx.measureText(shownEdge);
          const padX = 6;
          const padY = 3;
          const w2 = metrics.width + padX * 2;
          const h2 = 14 + padY;
          ctx.save();
          ctx.fillStyle = 'rgba(10,17,20,0.85)';
          ctx.strokeStyle = 'rgba(45,212,191,0.35)';
          ctx.lineWidth = 1;
          const bx = mx - w2 / 2;
          const by = my - h2 / 2 - 1;
          ctx.beginPath();
          // rounded rect (radius 5).
          const r = 5;
          ctx.moveTo(bx + r, by);
          ctx.lineTo(bx + w2 - r, by);
          ctx.quadraticCurveTo(bx + w2, by, bx + w2, by + r);
          ctx.lineTo(bx + w2, by + h2 - r);
          ctx.quadraticCurveTo(bx + w2, by + h2, bx + w2 - r, by + h2);
          ctx.lineTo(bx + r, by + h2);
          ctx.quadraticCurveTo(bx, by + h2, bx, by + h2 - r);
          ctx.lineTo(bx, by + r);
          ctx.quadraticCurveTo(bx, by, bx + r, by);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
          ctx.fillStyle = 'rgba(180,250,235,0.98)';
        }
        ctx.fillText(shownEdge, mx, my - 1);
      });

      // outer nodes.
      pts.forEach((p, i) => {
        const on = hover === i;
        const pulse = 1 + 0.06 * Math.sin(t * 0.003 + i);
        const rad = (on ? 9 : 6.5) * pulse;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + (on ? 7 : 4), 0, 6.2832);
        ctx.fillStyle = on
          ? 'rgba(45,212,191,0.20)'
          : 'rgba(45,212,191,0.08)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, 6.2832);
        ctx.fillStyle = '#0a1013';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = on ? '#7af0df' : '#2DD4BF';
        ctx.stroke();
        ctx.font = on
          ? "600 12px 'Pretendard', sans-serif"
          : "500 12px 'Pretendard', sans-serif";
        ctx.fillStyle = on ? '#eafffb' : '#aebfc2';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const ly = p.y + rad + 13;
        // ★ REQ-014-F: 노드 라벨도 truncate(12), hover 시 full.
        const shownLabel = on ? p.label : truncateLabel(p.label, 12);
        ctx.fillText(shownLabel, p.x, ly);
      });

      // center node.
      const cp = 1 + 0.05 * Math.sin(t * 0.0035);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 30 * cp);
      cg.addColorStop(0, 'rgba(45,212,191,0.45)');
      cg.addColorStop(1, 'rgba(45,212,191,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(cx, cy, 30 * cp, 0, 6.2832);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 13 * cp, 0, 6.2832);
      ctx.fillStyle = '#2DD4BF';
      ctx.fill();
      ctx.font = "700 12.5px 'Pretendard', sans-serif";
      ctx.fillStyle = '#04130f';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(center, cx, cy);

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
    };
  }, [center, nodes, height]);

  // hover 시 노출용 라벨 (SR / e2e / 라벨 잘렸을 때 툴팁 대체용).
  const hoveredEdge =
    hoverIdx >= 0 && hoverIdx < nodes.length ? nodes[hoverIdx] : null;

  return (
    <div
      data-testid="recall-mini-graph"
      data-hover-idx={hoverIdx}
      style={{
        position: 'relative',
        background:
          'radial-gradient(420px 280px at 50% 42%, #0c1519, #090d11)',
        border: '1px solid #14211f',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="recall-mini-graph-canvas"
        style={{
          display: 'block',
          width: '100%',
          height: `${height}px`,
          cursor: 'crosshair',
        }}
      />
      {/* SR-only + e2e-visible hover 콘텐츠. 라벨 잘림 시 full text 를
       *   DOM 에서도 볼 수 있도록 노출 (Canvas 는 텍스트가 아니므로). */}
      {hoveredEdge && (
        <span
          data-testid="recall-mini-graph-hover-label"
          style={{
            position: 'absolute',
            left: 13,
            top: 11,
            maxWidth: 'calc(100% - 26px)',
            padding: '4px 9px',
            borderRadius: 8,
            background: 'rgba(10,17,20,0.88)',
            border: '1px solid rgba(45,212,191,0.35)',
            fontSize: 11,
            color: '#c9f5ea',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {hoveredEdge.label}
          <span style={{ color: '#5a7c78', margin: '0 6px' }}>·</span>
          <span style={{ color: '#9ac8be' }}>{hoveredEdge.edge}</span>
        </span>
      )}
      <span
        className="font-mono"
        style={{
          position: 'absolute',
          left: 13,
          bottom: 11,
          fontSize: 10,
          color: '#3f5256',
          pointerEvents: 'none',
        }}
      >
        노드에 커서를 올리면 원문이 보입니다
      </span>
    </div>
  );
}
