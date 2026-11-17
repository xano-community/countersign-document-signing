import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** What a FormField hands its control: spread it onto the Input / Textarea / SelectTrigger. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/**
 * One form field, wired: the label points at the control, the hint (under the label) describes it, and an
 * error replaces the hint, is announced, and marks the control invalid.
 *
 *   <FormField label="Title" hint="What people see in the list" error={errors.title}>
 *     {(props) => <Input {...props} value={title} onChange={…} />}
 *   </FormField>
 */
export function FormField({ label, hint, error, optional = false, className, children }: {
  label: ReactNode;
  hint?: ReactNode;
  /** The server's 400 message, or your own check's. Empty: no error. */
  error?: string | null;
  /** Says "(optional)" beside the label. Fields without it read as required. */
  optional?: boolean;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error || hint;
  return (
    <div data-kit="form-field" className={cn("grid gap-1.5", className)}>
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="text-body font-medium">
          {label}{optional && <span className="font-normal text-muted-foreground">(optional)</span>}
        </Label>
        {error
          ? <p id={noteId} role="alert" className="text-caption text-destructive">{error}</p>
          : hint && <p id={noteId} className="text-caption text-muted-foreground">{hint}</p>}
      </div>
      {children({ id, "aria-describedby": note ? noteId : undefined, "aria-invalid": error ? true : undefined })}
    </div>
  );
}
