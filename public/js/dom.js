// @ts-check
// Typed DOM look-ups for the page (independent review of 0.18.0 §7.6): what the page queries, focuses or gets as an
// event's target is an HTML element (it acts on no SVG or MathML element), said once here instead of a cast at every
// use. Plain look-ups, no behavior of their own.

/** The first element under root matching sel, as an HTML element. @param {ParentNode} root @param {string} sel
 *  @returns {HTMLElement | null} */
export const q = (root, sel) => /** @type {HTMLElement | null} */ (root.querySelector(sel));

/** Every element under root matching sel, as HTML elements. @param {ParentNode} root @param {string} sel
 *  @returns {HTMLElement[]} */
export const qAll = (root, sel) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]);

/** A form field under root (input, textarea, select): its value and selection. @param {ParentNode} root
 *  @param {string} sel @returns {HTMLInputElement | null} */
export const field = (root, sel) => /** @type {HTMLInputElement | null} */ (root.querySelector(sel));

/** The focused element, as an HTML element (null: none). @param {Document} [doc] @returns {HTMLElement | null} */
export const activeEl = (doc = document) => /** @type {HTMLElement | null} */ (doc.activeElement);

/** An event's target (or related target), as an HTML element. @param {EventTarget | null | undefined} t
 *  @returns {HTMLElement} */
export const el = (t) => /** @type {HTMLElement} */ (t);

/** The nearest element at or above an event's target matching sel, as an HTML element (null: none, or a target that
 *  is no element). @param {EventTarget | null | undefined} t @param {string} sel @returns {HTMLElement | null} */
export const up = (t, sel) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (t)?.closest?.(sel) ?? null);
