// Lucide icons (the set the popup's reference design uses), rendered as inline SVG.
import {
  ArrowUp,
  Calendar,
  Camera,
  Check,
  ChevronRight,
  createElement,
  FileText,
  FormInput,
  Gem,
  Globe,
  ListTodo,
  Mail,
  Pencil,
  Plus,
  ReplaceAll,
  Search,
  Sparkle,
  Square,
  X,
  Zap,
  type IconNode,
} from "lucide";

export const icons = {
  arrowUp: ArrowUp,
  calendar: Calendar,
  camera: Camera,
  check: Check,
  chevron: ChevronRight,
  file: FileText,
  form: FormInput,
  gem: Gem,
  globe: Globe,
  listTodo: ListTodo,
  mail: Mail,
  pencil: Pencil,
  plus: Plus,
  replaceAll: ReplaceAll,
  search: Search,
  sparkle: Sparkle,
  square: Square,
  x: X,
  zap: Zap,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof icons;

export function icon(name: IconName, size = 16, strokeWidth = 2): SVGElement {
  const svg = createElement(icons[name], {
    width: size,
    height: size,
    "stroke-width": strokeWidth,
    "aria-hidden": "true",
  });
  svg.classList.add("icon", `icon-${name}`);
  return svg;
}

/** Replaces an element's content with an icon. */
export function setIcon(target: Element, name: IconName, size?: number, strokeWidth?: number): void {
  target.replaceChildren(icon(name, size, strokeWidth));
}
