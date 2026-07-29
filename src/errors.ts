export class EndpointCentralApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly body: unknown;

  constructor(status: number, endpoint: string, body: unknown) {
    super(EndpointCentralApiError.buildMessage(status, endpoint, body));
    this.name = "EndpointCentralApiError";
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }

  private static buildMessage(status: number, endpoint: string, body: unknown): string {
    const bodyText = typeof body === "string" ? body : JSON.stringify(body);

    if (status === 401) {
      return (
        `Authentication failed calling ${endpoint} (401). ` +
        `The API token is missing, invalid, expired, or has been superseded by a newer key ` +
        `(regenerating a key invalidates the previous one; deleting its user invalidates it too). ` +
        `Regenerate it in the Endpoint Central console under Admin -> Integrations -> API Key Management ` +
        `and update ENDPOINT_CENTRAL_API_TOKEN. Response: ${bodyText}`
      );
    }

    if (status === 403) {
      return (
        `Access denied calling ${endpoint} (403). ` +
        `The account tied to this API token does not have permission for this operation ` +
        `(check its role in Admin -> User Administration). Response: ${bodyText}`
      );
    }

    return `Endpoint Central API request to ${endpoint} failed with status ${status}: ${bodyText}`;
  }
}

export class ConfirmationRequiredError extends Error {
  constructor(action: string) {
    super(
      `${action} is a mutating/destructive action and requires confirm: true to proceed. ` +
        `Re-run the same tool call with confirm set to true once you're sure.`
    );
    this.name = "ConfirmationRequiredError";
  }
}

/**
 * Every mutating/destructive tool (patch install, agent uninstall, custom
 * field delete, etc.) must call this before touching the API. Keeps the
 * confirm-gate behavior identical across all such tools instead of each one
 * reimplementing the check.
 */
export function assertConfirmed(confirm: boolean | undefined, action: string): void {
  if (!confirm) {
    throw new ConfirmationRequiredError(action);
  }
}
