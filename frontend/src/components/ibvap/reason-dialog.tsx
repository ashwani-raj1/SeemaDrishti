import { useEffect, useState } from "react";
import {
  Dialog, DialogClose, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "./spinner";

/**
 * Escalate and dismiss carry a stated reason, and the node enforces it with a
 * 422 -- this dialog is the screen agreeing with the database rather than a
 * politeness. Cancelling leaves the incident exactly as it was.
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  pending,
  error,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const tooShort = reason.trim().length < 3;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="ibvap-reason">Reason</FieldLabel>
          <Textarea
            id="ibvap-reason"
            value={reason}
            autoFocus
            rows={3}
            aria-invalid={error ? true : undefined}
            placeholder="What did you see, and what did you decide?"
            onChange={(event) => setReason(event.target.value)}
          />
          <FieldDescription>
            {error ?? "Recorded in the audit log against your name, permanently."}
          </FieldDescription>
        </Field>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={tooShort || pending}
            onClick={() => onConfirm(reason.trim())}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
