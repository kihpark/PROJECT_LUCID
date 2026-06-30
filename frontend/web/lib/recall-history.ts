/**
 * ★ REQ-011-v1 (★ PO 2026-06-30) — Recall 최근 이력 예시 데이터.
 *
 * v1 = 예시. v2 = backend endpoint 신설 후 실데이터.
 * PO 결정 verbatim (REQ-011-v1 의뢰서 §0):
 *   "최근 recall = v1 = 예시"
 *
 * 의뢰서 §3-4 verbatim:
 *   "시안엔 3개: 답변 2종 + 경계 밖 1종."
 *
 * 의뢰서 §10 / 시안 q1/q2/unknown 의 카피 verbatim 복제.
 */

export type RecallExampleFact = {
  s: string;
  p: string;
  o: string;
  src: string;
  date: string;
  by: string;
};

export type RecallExampleGraphNode = {
  label: string;
  edge: string;
};

export type RecallExampleAnswerQuery = {
  qid: string;
  state: 'answer';
  q: string;
  when: string;
  factsLabel: string;
  metaColor: string;
  answer: string;
  chips: string[];
  conf: { facts: number; sources: number };
  boundary: string;
  facts: RecallExampleFact[];
  graph: { center: string; nodes: RecallExampleGraphNode[] };
};

export type RecallExampleUnknownQuery = {
  qid: string;
  state: 'unknown';
  q: string;
  when: string;
  factsLabel: string; // '경계 밖'
  metaColor: string;
};

export type RecallExampleQuery =
  | RecallExampleAnswerQuery
  | RecallExampleUnknownQuery;

export const EXAMPLE_RECENT_RECALL: RecallExampleQuery[] = [
  {
    qid: 'q1',
    state: 'answer',
    q: 'SpaceX 상장에 대해 알려줘',
    when: '방금',
    factsLabel: '사실 3건',
    metaColor: '#5a8f86',
    answer:
      '당신이 검증한 사실에 따르면, SpaceX는 2024년 나스닥에 상장했고 공모가는 주당 $135였습니다. 상장 주관사는 골드만삭스였습니다.',
    chips: ['나스닥 상장', '$135', '2024', '골드만삭스'],
    conf: { facts: 3, sources: 3 },
    boundary: '상장 후 주가 추이',
    facts: [
      { s: 'SpaceX', p: '상장하다', o: '나스닥 (2024)', src: 'Bloomberg', date: '2026.05.18', by: '박기흥' },
      { s: 'SpaceX', p: '공모가', o: '주당 $135', src: 'WSJ', date: '2026.05.18', by: '박기흥' },
      { s: 'SpaceX', p: '주관사', o: '골드만삭스', src: 'Reuters', date: '2026.05.20', by: '박기흥' },
    ],
    graph: {
      center: 'SpaceX',
      nodes: [
        { label: '나스닥', edge: '상장' },
        { label: '$135', edge: '공모가' },
        { label: '골드만삭스', edge: '주관사' },
        { label: '2024', edge: '시점' },
      ],
    },
  },
  {
    qid: 'q2',
    state: 'answer',
    q: '바이오빅데이터 회의 현황',
    when: '12분 전',
    factsLabel: '사실 4건',
    metaColor: '#5a8f86',
    answer:
      '바이오빅데이터 사업단은 2026년 6월 제29차 운영위원회를 개최했습니다. 회의에서는 국가 바이오 데이터 표준안이 의결되었고, 참여 기관은 12곳으로 확대되었습니다.',
    chips: ['제29차 회의', '표준안 의결', '12개 기관'],
    conf: { facts: 4, sources: 2 },
    boundary: '다음 회의 일정',
    facts: [
      { s: '바이오빅데이터 사업단', p: '개최하다', o: '제29차 운영위원회', src: '보도자료', date: '2026.06.11', by: '박기흥' },
      { s: '제29차 회의', p: '의결하다', o: '바이오 데이터 표준안', src: '회의록', date: '2026.06.11', by: '박기흥' },
      { s: '참여 기관', p: '확대되다', o: '12개 기관', src: '보도자료', date: '2026.06.12', by: '박기흥' },
      { s: '표준안', p: '적용 시점', o: '2026년 하반기', src: '회의록', date: '2026.06.12', by: '박기흥' },
    ],
    graph: {
      center: '바이오빅데이터',
      nodes: [
        { label: '제29차 회의', edge: '개최' },
        { label: '표준안', edge: '의결' },
        { label: '12개 기관', edge: '참여' },
        { label: '2026 하반기', edge: '적용' },
      ],
    },
  },
  {
    qid: 'unknown',
    state: 'unknown',
    q: '테슬라 4분기 실적은?',
    when: '1시간 전',
    factsLabel: '경계 밖',
    metaColor: '#b98a6a',
  },
];

// 의뢰서 §3-5 verbatim — 그래프 렌즈 패섯 예시 (★ v1 = 예시, v2 = facets endpoint).
export const EXAMPLE_ENTITIES: { name: string; count: number }[] = [
  { name: 'SpaceX', count: 14 },
  { name: '바이오빅데이터', count: 9 },
  { name: '입법연구', count: 7 },
  { name: '홍명보', count: 5 },
  { name: '나스닥', count: 4 },
  { name: '골드만삭스', count: 3 },
];

export const EXAMPLE_PREDICATES: { name: string; count: number }[] = [
  { name: '상장하다', count: 6 },
  { name: '개최하다', count: 5 },
  { name: '발의하다', count: 4 },
  { name: '의결하다', count: 3 },
];
