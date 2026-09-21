import {Line, Node, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, createRef, easeInOutCubic, waitFor} from '@motion-canvas/core';

// Explanatory values, not a captured Jev response or a provider benchmark.
// Policy selects the final pair; the classifier supplies the judgments.
const c = {
  background: '#0d1117', surface: '#161b22', ink: '#e6edf3', muted: '#a5afbd',
  border: '#3b4452', rule: '#2d3541', idleWire: '#748197',
  wire: '#ffd65a', confidence: '#c7b4f2', selected: '#1f211e',
};
const font = 'IBM Plex Sans';
const numericFont = 'IBM Plex Mono';

export default makeScene2D(function* (view) {
  // Wait for self-hosted fonts before rendering, including a cold browser load.
  yield Promise.all([
    document.fonts.load('400 24px "IBM Plex Sans"'),
    document.fonts.load('500 24px "IBM Plex Sans"'),
    document.fonts.load('600 24px "IBM Plex Sans"'),
    document.fonts.load('400 24px "IBM Plex Mono"'),
  ]);
  const taskPanel = createRef<Rect>();
  const jevPanel = createRef<Rect>();
  const policyPanel = createRef<Rect>();
  const signals = createRef<Node>();
  const jevHint = createRef<Txt>();
  const policyHint = createRef<Txt>();
  const policy = createRef<Node>();
  const customRule = createRef<Line>();
  const customLabel = createRef<Txt>();
  const customNote = createRef<Txt>();
  const resultPanel = createRef<Rect>();
  const result = createRef<Node>();
  const resultHint = createRef<Txt>();
  const pinned = createRef<Txt>();
  const routeCaption = createRef<Txt>();
  const toJev = createRef<Line>();
  const toPolicy = createRef<Line>();
  const toResult = createRef<Line>();
  const savedPath = createRef<Line>();
  const packet = createRef<Rect>();

  view.fill(c.background);
  // Frame only the flow, matching the compact README diagram.
  view.add(<Node y={-125}>
    <Line points={[[-399, 10], [-333, 10]]} stroke={c.idleWire} lineWidth={3} endArrow arrowSize={18}/>
    <Line points={[[221, 10], [307, 10]]} stroke={c.idleWire} lineWidth={3} endArrow arrowSize={18}/>
    <Line ref={toJev} points={[[-399, 10], [-333, 10]]} stroke={c.wire} lineWidth={4} endArrow arrowSize={18} end={0}/>
    <Line ref={toPolicy} points={[[221, 10], [307, 10]]} stroke={c.wire} lineWidth={4} endArrow arrowSize={18} end={0}/>
    <Line ref={toResult} points={[[535, 236], [535, 292], [535, 305]]} stroke={c.wire} lineWidth={4} endArrow arrowSize={18} end={0}/>
    <Line ref={savedPath} points={[[-580, 236], [-580, 305]]} stroke={c.wire} lineWidth={4} lineDash={[7, 8]} endArrow arrowSize={20} end={0}/>

    <Rect ref={taskPanel} x={-580} y={10} width={350} height={440} fill={c.surface} stroke={c.border} lineWidth={2} radius={12}>
      <Txt text="Your task" x={-143} y={-170} offsetX={-1} fontFamily={font} fontSize={35} fontWeight={600} fill={c.ink}/>
      <Txt text="A new conversation" x={-143} y={-123} offsetX={-1} fontFamily={font} fontSize={22} fill={c.muted}/>
      <Line points={[[-143, -91], [143, -91]]} stroke={c.rule} lineWidth={1}/>
      <Txt text={'Implement an LRU\ncache with get/put\noperations and\nunit tests.'} x={-143} y={10} offsetX={-1} fontFamily={font} fontSize={29} lineHeight={43} fill={c.ink}/>
      <Txt text="No manual model selection." x={-143} y={166} offsetX={-1} fontFamily={font} fontSize={20} fill={c.muted}/>
    </Rect>

    <Rect ref={jevPanel} x={-55} y={10} width={540} height={440} fill={c.surface} stroke={c.border} lineWidth={2} radius={12}>
      <Txt text="System One model" x={-234} y={-170} offsetX={-1} fontFamily={font} fontSize={34} fontWeight={600} fill={c.ink}/>
      <Txt text="1 API call" x={234} y={-123} offsetX={1} fontFamily={font} fontSize={20} fill={c.muted}/>
      <Txt text="(Jev)" x={-234} y={-123} offsetX={-1} fontFamily={font} fontSize={22} fill={c.muted}/>
      <Line points={[[-234, -91], [234, -91]]} stroke={c.rule} lineWidth={1}/>
      <Txt ref={jevHint} text={'Assesses what the task needs\nand how confident it is.'} y={33} fontFamily={font} fontSize={27} lineHeight={39} textAlign="center" fill={c.muted}/>
      <Node ref={signals} opacity={0}>
        {[
          {label: 'Capability', value: 'Balanced', confidence: '0.91'},
          {label: 'Enough context?', value: 'Yes', confidence: '0.98'},
          {label: 'Task type', value: 'Implement', confidence: '0.94'},
          {label: 'Effort for Terra', value: 'Medium', confidence: '0.86'},
        ].map((row, i) => <Node y={-51 + i * 54}>
          <Txt text={row.label} x={-234} offsetX={-1} fontFamily={font} fontSize={22} fill={c.muted}/>
          <Txt text={row.value} x={145} offsetX={1} fontFamily={font} fontSize={24} fontWeight={500} fill={c.ink}/>
          <Txt text={row.confidence} x={234} offsetX={1} fontFamily={numericFont} fontSize={21} fill={c.confidence}/>
          {i < 3 && <Line points={[[-234, 27], [234, 27]]} stroke={c.rule} lineWidth={1}/>}
        </Node>)}
        <Txt text="Effort = how much the coding model thinks." x={-234} y={167} offsetX={-1} fontFamily={font} fontSize={18} fill={c.muted}/>
        <Txt text="Numbers show confidence, from 0 to 1." x={-234} y={194} offsetX={-1} fontFamily={font} fontSize={18} fill={c.muted}/>
      </Node>
    </Rect>

    <Rect ref={policyPanel} x={535} y={10} width={440} height={440} fill={c.surface} stroke={c.border} lineWidth={2} radius={12}>
      <Txt text="Your policy" x={-184} y={-170} offsetX={-1} fontFamily={font} fontSize={35} fontWeight={600} fill={c.ink}/>
      <Txt text="Ready-to-use defaults" x={-184} y={-123} offsetX={-1} fontFamily={font} fontSize={22} fill={c.muted}/>
      <Line points={[[-184, -91], [184, -91]]} stroke={c.rule} lineWidth={1}/>
      <Txt ref={policyHint} text={'Local code applies your rules.\nYou control the final route.'} y={28} textAlign="center" fontFamily={font} fontSize={26} lineHeight={40} fill={c.muted}/>
      <Node ref={policy} opacity={0}>
        {['Check confidence', 'Choose an allowed model', 'Set its reasoning effort'].map((label, i) => <Node y={-53 + i * 56}>
          <Txt text={String(i + 1)} x={-184} offsetX={-1} fontFamily={numericFont} fontSize={19} fill={c.muted}/>
          <Txt text={label} x={-148} offsetX={-1} fontFamily={font} fontSize={24} fill={c.ink}/>
        </Node>)}
        <Line ref={customRule} points={[[-184, 112], [184, 112]]} stroke={c.rule} lineWidth={1}/>
        <Txt ref={customLabel} text="Works out of the box" x={-184} y={148} offsetX={-1} fontFamily={font} fontSize={25} fontWeight={500} fill={c.ink}/>
        <Txt ref={customNote} text="You can customize these rules." x={-184} y={185} offsetX={-1} fontFamily={font} fontSize={19} fill={c.muted}/>
      </Node>
    </Rect>

    {[-405, -325, 215, 315].map(x => <Rect x={x} y={10} width={9} height={9} fill={c.surface} stroke={c.idleWire} lineWidth={2} radius={1}/>)}
    <Rect ref={resultPanel} y={376} width={1510} height={126} fill={c.surface} stroke={c.border} lineWidth={2} radius={12}>
      <Txt ref={resultHint} text="The final model + effort are selected after policy is applied." fontFamily={font} fontSize={29} fill={c.muted}/>
      <Node ref={result} opacity={0}>
        <Txt text="Selected route" x={-717} y={-30} offsetX={-1} fontFamily={font} fontSize={20} fill={c.muted}/>
        <Txt text="GPT-5.6 Terra / medium" x={-717} y={15} offsetX={-1} fontFamily={font} fontSize={38} fontWeight={600} fill={c.wire}/>
        <Line points={[[30, -33], [30, 33]]} stroke={c.border} lineWidth={2}/>
        <Txt ref={pinned} text="Your coding provider does the work." x={77} y={-21} offsetX={-1} fontFamily={font} fontSize={29} fontWeight={500} fill={c.ink}/>
        <Txt ref={routeCaption} text="Model judgments. Your policy decides." x={77} y={22} offsetX={-1} fontFamily={font} fontSize={23} fill={c.muted}/>
      </Node>
    </Rect>
    <Rect ref={packet} width={8} height={8} radius={1} fill={c.wire} opacity={0}/>
    <Txt text="Illustrative example and confidence values · Confidence is not a measured success probability." y={480} fontFamily={font} fontSize={19} fill={c.muted}/>
  </Node>);

  yield* taskPanel().stroke(c.wire, 0.45);
  yield* waitFor(1.6);
  packet().position([-403, 10]);
  packet().opacity(1);
  yield* all(toJev().end(1, 0.6), packet().position([-330, 10], 0.6, easeInOutCubic));
  packet().opacity(0);
  yield* all(taskPanel().stroke(c.border, 0.3), jevPanel().stroke(c.wire, 0.3));
  yield* waitFor(1.7);
  yield* all(jevHint().opacity(0, 0.3), signals().opacity(1, 0.5));
  yield* waitFor(3.2);

  packet().position([223, 10]);
  packet().opacity(1);
  yield* all(toPolicy().end(1, 0.6), packet().position([294, 10], 0.6, easeInOutCubic));
  packet().opacity(0);
  yield* all(jevPanel().stroke(c.border, 0.3), policyPanel().stroke(c.wire, 0.3), policyHint().opacity(0, 0.3), policy().opacity(1, 0.5));
  yield* waitFor(3.3);

  yield* customRule().stroke(c.wire, 0.4);
  customLabel().text('Make the rules yours');
  customLabel().fill(c.wire);
  customNote().text('Choose models and effort limits.');
  yield* waitFor(2.8);

  yield* toResult().end(1, 0.65);
  yield* all(resultHint().opacity(0, 0.2), result().opacity(1, 0.5), resultPanel().fill(c.selected, 0.5), resultPanel().stroke(c.wire, 0.5));
  yield* waitFor(2.1);

  pinned().text('Pinned for this conversation.');
  routeCaption().text('No model switches to disrupt the cache.');
  yield* savedPath().end(1, 0.8);
  packet().fill(c.wire);
  for (let i = 0; i < 2; i++) {
    packet().position([-580, 236]);
    packet().opacity(1);
    yield* packet().position([-580, 295], 0.65, easeInOutCubic);
    packet().opacity(0);
    yield* waitFor(0.15);
  }
  yield* waitFor(3.1);
});
