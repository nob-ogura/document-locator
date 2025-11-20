declare module "pg" {
  type SSLConfig = { rejectUnauthorized?: boolean } | boolean;

  export interface ClientConfig {
    connectionString?: string;
    ssl?: SSLConfig;
    [key: string]: unknown;
  }

  export interface QueryResult<T = unknown> {
    rows: T[];
  }

  export class Client {
    constructor(config?: ClientConfig);
    connect(): Promise<void>;
    end(): Promise<void>;
    query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  }
}
