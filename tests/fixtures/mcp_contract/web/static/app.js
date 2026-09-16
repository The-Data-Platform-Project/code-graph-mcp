import { format } from './format.js';

export function render(items) {
  return items.map((item) => format(item));
}
