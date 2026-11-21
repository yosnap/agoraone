import type { Delegated } from '../api/core';

// A question another section asks Watson to start with (e.g. «Pasar a Watson» of a bot's answer in Agentes): kept
// here, taken once by the assistant when it is on screen, which sends it in a new conversation.

let pending: { text: string; delegated?: Delegated } | null = null;
export const askWatson = (text: string, delegated?: Delegated) => { pending = { text, delegated }; };
export const takeWatsonAsk = () => { const ask = pending; pending = null; return ask; };
