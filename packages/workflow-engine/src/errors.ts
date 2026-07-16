import type { FactoryErrorCode } from "@mkcode/factory-contracts";

export class WorkflowEngineError extends Error {
  readonly code: FactoryErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: FactoryErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "WorkflowEngineError";
    this.code = code;
    this.details = details;
  }
}

export const isWorkflowEngineError = (value: unknown): value is WorkflowEngineError =>
  value instanceof WorkflowEngineError;
