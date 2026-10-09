// Which screen the address names (R-006). Pure: no page access, so every input can be tried.
//
// The address hash is typed, pasted or crafted by anyone, so it is read strictly and never decoded:
// only these exact forms are routes, and anything else (an unknown name, a trailing slash, a query,
// an encoded character, a bad id, text that is not text) is the home screen.
//
//   #/  or nothing      home
//   #/circles           the person's circles
//   #/circles/<id>      one circle (the id must be exactly the shape the service makes)
//   #/invitations       invitations addressed to the person
//   #/capture           file a note
//   #/brain             browse your own categories and items

import { isCircleId } from './circles-client.js';

const HOME = Object.freeze({ name: 'home' });
const CIRCLES = Object.freeze({ name: 'circles' });
const INVITATIONS = Object.freeze({ name: 'invitations' });
const CAPTURE = Object.freeze({ name: 'capture' });
const BRAIN = Object.freeze({ name: 'brain' });
const CIRCLE_PREFIX = '#/circles/';

/** The route an address hash names; anything that is not exactly one of ours is home. */
export function parseHash(hash) {
  if (typeof hash !== 'string') return HOME;
  if (hash === '#/circles') return CIRCLES;
  if (hash === '#/invitations') return INVITATIONS;
  if (hash === '#/capture') return CAPTURE;
  if (hash === '#/brain') return BRAIN;
  if (hash.startsWith(CIRCLE_PREFIX)) {
    const id = hash.slice(CIRCLE_PREFIX.length);
    return isCircleId(id) ? Object.freeze({ name: 'circle', id }) : HOME;
  }
  return HOME;
}

/** The one address for a route. A route that is not one of ours, or a circle with a bad id, is the home address. */
export function hashFor(route) {
  if (!route || typeof route !== 'object') return '#/';
  if (route.name === 'circles') return '#/circles';
  if (route.name === 'invitations') return '#/invitations';
  if (route.name === 'capture') return '#/capture';
  if (route.name === 'brain') return '#/brain';
  if (route.name === 'circle' && isCircleId(route.id)) return `${CIRCLE_PREFIX}${route.id}`;
  return '#/';
}

/** True when two routes are the same screen. */
export const sameRoute = (a, b) => hashFor(a) === hashFor(b);

/** The canonical address for whatever was in the address bar: `hashFor(parseHash(hash))`. */
export const normalise = (hash) => hashFor(parseHash(hash));
