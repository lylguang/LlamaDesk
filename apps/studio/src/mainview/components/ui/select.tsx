import * as React from "react";
import {
  Select as AppicaSelect,
  SelectContent as AppicaSelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectSeparator,
  SelectTrigger as AppicaSelectTrigger,
  SelectValue,
} from "@appica/ui-react/select";

/*
 * Base UI 把 select 的值类型推为 unknown;业务代码全部按 string 使用,
 * 这里在适配器收窄为 string,调用方无需感知。
 */
type SelectProps = Omit<
  React.ComponentProps<typeof AppicaSelect>,
  "value" | "defaultValue" | "onValueChange" | "multiple" | "items"
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

/*
 * Radix 的 SelectValue 能显示选中项的子节点文本;Base UI 必须在 Root 传 items 映射。
 * 这里从 children 元素树中提取 SelectItem 的 value → 文本映射,调用方保持旧写法。
 */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractText(props?.children);
  }
  return "";
}

function collectItemLabels(children: React.ReactNode, map: Record<string, string>) {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as {
      value?: unknown;
      children?: React.ReactNode;
    };
    if (props?.value != null) {
      const label = extractText(props.children);
      if (label) map[String(props.value)] = label;
    }
    if (props?.children != null) collectItemLabels(props.children, map);
  });
}

function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  ...props
}: SelectProps) {
  const items: Record<string, string> = {};
  if (children != null) collectItemLabels(children, items);
  const hasItems = Object.keys(items).length > 0;

  return (
    <AppicaSelect
      data-slot="select"
      items={hasItems ? items : undefined}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange ? (v: unknown) => onValueChange(v as string) : undefined}
      {...props}
    >
      {children}
    </AppicaSelect>
  );
}

function SelectTrigger({
  className,
  ...props
}: React.ComponentProps<typeof AppicaSelectTrigger> & {
  /* 旧 API 的高度选项,Appica 统一走默认尺寸,仅为兼容保留 */
  size?: "sm" | "default";
}) {
  return <AppicaSelectTrigger data-slot="select-trigger" className={className} {...props} />;
}

/*
 * 旧 position="item-aligned"(Radix 语义)即 Appica 的 alignItemWithTrigger(默认开);
 * position="popper" 时浮层独立于触发器定位,对应 alignItemWithTrigger={false}。
 */
function SelectContent({
  position,
  ...props
}: React.ComponentProps<typeof AppicaSelectContent> & {
  position?: "item-aligned" | "popper";
}) {
  return (
    <AppicaSelectContent
      data-slot="select-content"
      alignItemWithTrigger={position === "popper" ? false : undefined}
      {...props}
    />
  );
}

function SelectLabel(props: React.ComponentProps<typeof SelectGroupLabel>) {
  return <SelectGroupLabel data-slot="select-label" {...props} />;
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
