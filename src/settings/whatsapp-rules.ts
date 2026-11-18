import type { ChatRule, ChatRuleIn, Level, MailRuleAction } from '../api/core';

/** The rule form as the user types it: every field a string, the empty string meaning «none». */
export type ChatRuleForm = {
  name: string; contact: string; accountId: string; words: string; action: MailRuleAction; label: string; scopeId: string; confidentiality: string;
};

export const emptyChatRuleForm: ChatRuleForm = { name: '', contact: '', accountId: '', words: '', action: 'client', label: '', scopeId: '', confidentiality: '' };

const text = (value: string) => value.trim() || null;
const id = (value: string) => (value ? Number(value) : null);

/** What is sent to the core; fields left empty clear the rule's value (the core checks there is a condition). */
export function chatRuleFromForm(form: ChatRuleForm, enabled = true): ChatRuleIn {
  return {
    name: form.name.trim(), contact: text(form.contact), accountId: id(form.accountId), words: text(form.words), action: form.action,
    label: text(form.label), scopeId: id(form.scopeId), confidentiality: (form.confidentiality || null) as Level | null, enabled,
  };
}

export function chatRuleForm(rule: ChatRule): ChatRuleForm {
  return {
    name: rule.name, contact: rule.contact ?? '', accountId: rule.accountId ? String(rule.accountId) : '', words: rule.words ?? '', action: rule.action,
    label: rule.label ?? '', scopeId: rule.scopeId ? String(rule.scopeId) : '', confidentiality: rule.confidentiality ?? '',
  };
}

/** The rule's condition in words, for the list. */
export function describeChatRule(rule: ChatRule, accountName: (id: number) => string): string {
  return [
    rule.contact && `de ${rule.contact}`, rule.accountId && `en ${accountName(rule.accountId)}`, rule.words && `palabras: ${rule.words}`,
  ].filter(Boolean).join(' · ');
}
