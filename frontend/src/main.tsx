import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const stages = [
  ['Establish Authority', 'Define the resources and actions an agent may request.', 'Authority is not yet confirmed.'],
  ['Agent Execution', 'Give the agent a goal. EAGLE will inspect every proposed action.', 'Workflow connection is staged for a later milestone.'],
  ['Compare the Evidence', 'Review trusted quotation evidence and deterministic tradeoffs.', 'Evidence appears only after a real gateway read.'],
  ['Control the Action', 'Blocked actions stop here. Eligible actions wait for a human.', 'No approval request is active.'],
  ['Verify the Outcome', 'Inspect durable receipts before accepting an execution claim.', 'No session evidence has been collected.']
] as const;

function Aperture() { return <div className="aperture" aria-hidden="true"><div className="orbit orbit-a"/><div className="orbit orbit-b"/><div className="iris"><i/><i/><i/><i/><b/></div><span className="tick t1"/><span className="tick t2"/><span className="tick t3"/><small>AUTHORIZATION<br/>BOUNDARY</small></div>; }
function Brand(){ return <div className="brand">EAGLE<span>.</span></div>; }
function Landing({ enter }: { enter(): void }) { return <main className="landing"><header><Brand/><nav><a href="#about">ABOUT</a><button aria-label="Open navigation">+</button></nav></header><section className="hero"><div className="hero-copy"><p className="eyebrow">EXECUTION SECURITY LAYER <em>01</em></p><h1>Intelligence<br/>needs <i>boundaries.</i></h1><p className="lede">AI agents can think, plan, and propose. EAGLE controls what they can actually execute.</p><button className="primary" onClick={enter}>Enter Eagle <span>→</span></button><p className="micro">An execution security layer for autonomous agents.</p></div><Aperture/></section><footer id="about"><span>DESIGNED FOR HIGH-TRUST AGENTS</span><span>GATEWAY · POLICY · HUMAN CONTROL</span></footer></main>; }
function Guided({ leave }: { leave(): void }) { const [step, setStep] = useState(0); const [title, copy, state] = stages[step]; return <main className="guided"><header><Brand/><button className="quiet" onClick={leave}>Exit experience</button></header><div className="progress"><span>STEP {String(step + 1).padStart(2,'0')} OF 05</span><div>{stages.map((_, i)=><i className={i<=step?'active':''} key={i}/>)}</div></div><section className="stage"><p className="eyebrow">GUIDED SECURITY EXPERIENCE</p><h1>{title}.</h1><p>{copy}</p><aside><span className="status-dot"/> <strong>UI SCAFFOLDING</strong><small>{state}</small></aside></section><footer><button className="quiet" disabled={!step} onClick={()=>setStep(step-1)}>← Previous</button><button className="primary" onClick={()=>setStep(Math.min(4,step+1))}>{step===4?'Return to start':'Continue'} <span>→</span></button></footer></main>; }
function App(){ const [entered,setEntered]=useState(false); return entered?<Guided leave={()=>setEntered(false)}/>:<Landing enter={()=>setEntered(true)}/>; }
createRoot(document.getElementById('root')!).render(<App/>);
