/**
 * Barrel for the design system. Primitives are shadcn (Base UI) files; the
 * composites at the bottom are product-specific and keep a stable API.
 */
export { Button, buttonVariants } from "./button";
export { Badge, badgeVariants, type BadgeVariant } from "./badge";
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";
export { Input } from "./input";
export { Textarea } from "./textarea";
export { Label } from "./label";
export { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "./native-select";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "./field";
export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants } from "./tabs";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";
export { Popover, PopoverContent, PopoverTrigger } from "./popover";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";
export { Alert, AlertDescription, AlertTitle } from "./alert";
export { Separator } from "./separator";
export { Skeleton } from "./skeleton";
export { Switch } from "./switch";
export { Checkbox } from "./checkbox";
export { RadioGroup, RadioGroupItem } from "./radio-group";
export { Progress } from "./progress";
export { Kbd, KbdGroup } from "./kbd";
export { ScrollArea, ScrollBar } from "./scroll-area";
export { Avatar, AvatarFallback, AvatarImage } from "./avatar";
export { Toggle, toggleVariants } from "./toggle";
export { ToggleGroup, ToggleGroupItem } from "./toggle-group";
export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./empty";

// Product composites.
export { PageHeader } from "./page-header";
export { EmptyState } from "./empty-state";
export { Stat, StatStrip } from "./stat";
export { Section, SectionHeader } from "./section";
export { InfoTip } from "./info-tip";
export { cn } from "@/lib/utils";
