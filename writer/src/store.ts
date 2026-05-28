/**
 * Card stream store — pub/sub over a Card[] array.
 * This is the entire state of the document.
 */

import type { Card, LockState } from "./types";

type Listener = (cards: Card[]) => void;

let cards: Card[] = [];
let focusedCardId: string | null = null;
const listeners: Set<Listener> = new Set();
const focusListeners: Set<(id: string | null) => void> = new Set();

function notify() {
  for (const fn of listeners) fn(cards);
}

function notifyFocus() {
  for (const fn of focusListeners) fn(focusedCardId);
}

export const store = {
  getCards(): Card[] {
    return cards;
  },

  getFocusedCardId(): string | null {
    return focusedCardId;
  },

  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  onFocusChange(fn: (id: string | null) => void) {
    focusListeners.add(fn);
    return () => focusListeners.delete(fn);
  },

  loadStream(stream: Card[]) {
    cards = stream;
    notify();
  },

  updateCard(id: string, content: any) {
    const idx = cards.findIndex((c) => c.id === id);
    if (idx === -1) return;
    cards[idx] = { ...cards[idx], content, lock: "user" as LockState };
    notify();
  },

  confirmCard(id: string) {
    const idx = cards.findIndex((c) => c.id === id);
    if (idx === -1) return;
    cards[idx] = { ...cards[idx], lock: "user" as LockState };
    notify();
  },

  deleteCard(id: string) {
    cards = cards.filter((c) => c.id !== id);
    notify();
  },

  insertCard(card: Card, afterId?: string) {
    if (afterId) {
      const idx = cards.findIndex((c) => c.id === afterId);
      if (idx !== -1) {
        cards.splice(idx + 1, 0, card);
      } else {
        cards.push(card);
      }
    } else {
      cards.push(card);
    }
    notify();
  },

  setFocus(id: string | null) {
    if (focusedCardId === id) return;
    focusedCardId = id;
    notifyFocus();
  },

  // Get stats for progress display
  getProgress() {
    const total = cards.filter(
      (c) => !["canonical_badge", "suggestion", "hook", "pitfall"].includes(c.type)
    ).length;
    const confirmed = cards.filter((c) => c.lock === "user").length;
    return { confirmed, total };
  },
};
