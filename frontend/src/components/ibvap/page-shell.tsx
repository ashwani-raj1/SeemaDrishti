import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/** One step above the current page. The last crumb is the page itself. */
export interface Crumb {
  label: string;
  to: string;
}

/** The frame every section sits in, so no screen invents its own header. */
export function PageShell({
  title,
  description,
  actions,
  toolbar,
  breadcrumbs,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  /**
   * The trail back up. Present on detail pages, which are reached by a link
   * somebody may have been sent -- so the way back has to be on the page
   * rather than in the history of a session they were never part of.
   */
  breadcrumbs?: Crumb[];
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 p-3 sm:p-4 xl:p-6">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb>
          <BreadcrumbList>
            {breadcrumbs.map((crumb) => (
              <span key={crumb.to} className="contents">
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link to={crumb.to}>{crumb.label}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </span>
            ))}
            <BreadcrumbItem>
              <BreadcrumbPage className="max-w-[60ch] truncate">{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      )}

      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          {title ? (
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-lg font-semibold tracking-tight sm:text-xl">{title}</h1>
              {description && <p className="max-w-4xl text-xs leading-5 text-muted-foreground sm:text-sm">{description}</p>}
            </div>
          ) : (
            <div />
          )}
          {actions && <div className="flex max-w-full items-center gap-2">{actions}</div>}
        </div>
      )}
      {toolbar}
      {children}
    </div>
  );
}
