// Lucide icons (the set the popup's reference design uses), rendered as inline SVG.
import {
  AppWindow,
  ArrowUp,
  Bookmark,
  Calendar,
  Camera,
  Check,
  ChevronRight,
  Cloud,
  Copy,
  Cpu,
  createElement,
  Eye,
  FileText,
  FormInput,
  Gem,
  Globe,
  Keyboard,
  ListTodo,
  Mail,
  Mouse,
  MousePointerClick,
  Pencil,
  Plus,
  ReplaceAll,
  Search,
  Settings,
  Sparkle,
  Square,
  Undo2,
  X,
  Zap,
  type IconNode,
} from "lucide";

export const icons = {
  appWindow: AppWindow,
  arrowUp: ArrowUp,
  bookmark: Bookmark,
  calendar: Calendar,
  camera: Camera,
  check: Check,
  chevron: ChevronRight,
  cloud: Cloud,
  copy: Copy,
  cpu: Cpu,
  eye: Eye,
  file: FileText,
  form: FormInput,
  gem: Gem,
  globe: Globe,
  keyboard: Keyboard,
  listTodo: ListTodo,
  mail: Mail,
  mouse: Mouse,
  pointerClick: MousePointerClick,
  pencil: Pencil,
  plus: Plus,
  replaceAll: ReplaceAll,
  search: Search,
  settings: Settings,
  sparkle: Sparkle,
  square: Square,
  undo: Undo2,
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
