export const templates = {
  "3-tier": {
    name: "3-Tier Web Architecture",
    nodes: [
      { id: "client1", type: "archNode", data: { label: "Web Client", systemType: "client", description: "Browser / SPA" } },
      { id: "lb", type: "archNode", data: { label: "Load Balancer", systemType: "cloud", description: "Nginx / ALB" } },
      { id: "app1", type: "archNode", data: { label: "App Server 1", systemType: "server", description: "Node.js / Python API" } },
      { id: "app2", type: "archNode", data: { label: "App Server 2", systemType: "server", description: "Node.js / Python API" } },
      { id: "cache", type: "archNode", data: { label: "Redis Cache", systemType: "cache", description: "Session & Query Cache" } },
      { id: "db1", type: "archNode", data: { label: "Primary Database", systemType: "database", description: "PostgreSQL" } },
      { id: "db2", type: "archNode", data: { label: "Read Replica", systemType: "database", description: "PostgreSQL" } }
    ],
    edges: [
      { id: "e1", source: "client1", target: "lb", label: "HTTPS", animated: true },
      { id: "e2", source: "lb", target: "app1", animated: true },
      { id: "e3", source: "lb", target: "app2", animated: true },
      { id: "e4", source: "app1", target: "cache", label: "Read/Write" },
      { id: "e5", source: "app2", target: "cache", label: "Read/Write" },
      { id: "e6", source: "app1", target: "db1", label: "Write" },
      { id: "e7", source: "app2", target: "db1", label: "Write" },
      { id: "e8", source: "app1", target: "db2", label: "Read" },
      { id: "e9", source: "app2", target: "db2", label: "Read" },
      { id: "e10", source: "db1", target: "db2", label: "Replication", animated: true }
    ]
  },
  "microservices": {
    name: "Microservices E-Commerce",
    nodes: [
      { id: "api-gw", type: "archNode", data: { label: "API Gateway", systemType: "cloud", description: "Kong / AWS API GW" } },
      { id: "auth", type: "archNode", data: { label: "Auth Service", systemType: "server", description: "JWT / OAuth2" } },
      { id: "user-svc", type: "archNode", data: { label: "User Service", systemType: "server", description: "Profile Management" } },
      { id: "cart-svc", type: "archNode", data: { label: "Cart Service", systemType: "server", description: "Shopping Cart" } },
      { id: "order-svc", type: "archNode", data: { label: "Order Service", systemType: "server", description: "Order Processing" } },
      { id: "user-db", type: "archNode", data: { label: "User DB", systemType: "database", description: "PostgreSQL" } },
      { id: "cart-cache", type: "archNode", data: { label: "Cart Cache", systemType: "cache", description: "Redis" } },
      { id: "order-db", type: "archNode", data: { label: "Order DB", systemType: "database", description: "MongoDB" } },
      { id: "event-bus", type: "archNode", data: { label: "Event Bus", systemType: "cloud", description: "Kafka / RabbitMQ" } }
    ],
    edges: [
      { id: "em1", source: "api-gw", target: "auth", label: "Verify Token", animated: true },
      { id: "em2", source: "api-gw", target: "user-svc", animated: true },
      { id: "em3", source: "api-gw", target: "cart-svc", animated: true },
      { id: "em4", source: "api-gw", target: "order-svc", animated: true },
      { id: "em5", source: "user-svc", target: "user-db" },
      { id: "em6", source: "cart-svc", target: "cart-cache" },
      { id: "em7", source: "order-svc", target: "order-db" },
      { id: "em8", source: "order-svc", target: "event-bus", label: "Publish OrderCreated", animated: true },
      { id: "em9", source: "user-svc", target: "event-bus", label: "Subscribe", animated: true }
    ]
  },
  "data-pipeline": {
    name: "Real-Time Data Pipeline",
    nodes: [
      { id: "sources", type: "archNode", data: { label: "Data Sources", systemType: "client", description: "IoT / Logs / Apps" } },
      { id: "ingestion", type: "archNode", data: { label: "Ingestion API", systemType: "server", description: "REST / gRPC" } },
      { id: "queue", type: "archNode", data: { label: "Message Queue", systemType: "cloud", description: "Apache Kafka" } },
      { id: "stream-proc", type: "archNode", data: { label: "Stream Processor", systemType: "server", description: "Apache Flink / Spark" } },
      { id: "data-lake", type: "archNode", data: { label: "Data Lake", systemType: "database", description: "S3 / GCS" } },
      { id: "data-warehouse", type: "archNode", data: { label: "Data Warehouse", systemType: "database", description: "Snowflake / BigQuery" } },
      { id: "bi-tool", type: "archNode", data: { label: "BI Dashboard", systemType: "client", description: "Tableau / Looker" } }
    ],
    edges: [
      { id: "ed1", source: "sources", target: "ingestion", label: "Events", animated: true },
      { id: "ed2", source: "ingestion", target: "queue", label: "Produce", animated: true },
      { id: "ed3", source: "queue", target: "stream-proc", label: "Consume", animated: true },
      { id: "ed4", source: "stream-proc", target: "data-lake", label: "Raw Storage" },
      { id: "ed5", source: "stream-proc", target: "data-warehouse", label: "Aggregated Metrics" },
      { id: "ed6", source: "bi-tool", target: "data-warehouse", label: "Query", animated: true }
    ]
  }
};
