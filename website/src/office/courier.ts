/** `/office/courier.html` (ADR-0102, addendum): see `courier-frame.ts`. */
import { OFFICE_ORIGIN } from "../lib/office-origins";
import { startCourierFrame } from "./courier-frame";

startCourierFrame({
  self: window,
  parent: window.parent === window ? null : window.parent,
  officeOrigin: OFFICE_ORIGIN,
  fetch: (...args) => fetch(...args),
  cookie: () => document.cookie,
});
