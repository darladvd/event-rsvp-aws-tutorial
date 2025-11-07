// Import MySQL (with async/await support) and AWS SDK DynamoDB client
import mysql from 'mysql2/promise';
import {
  DynamoDBClient,
  BatchGetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand
} from "@aws-sdk/client-dynamodb";

// Initialize DynamoDB client using the region from environment variables
const dynamo = new DynamoDBClient({ region: process.env.REGION });

/*
  AWS Lambda main handler function.
  This receives all API Gateway requests — GET, POST, etc. —
  and routes them based on method + path.
*/ 
export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  // Extract useful parts of the API Gateway event
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const pathParams = event.pathParameters || {};
  const queryParams = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // Handle CORS preflight request for browsers
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With",
        "Access-Control-Allow-Credentials": true
      },
      body: ''
    };
  }

  // Connect to MySQL using environment variables for credentials
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

  try {
    /*
      ===============================
      ROUTE: GET /event/{event_id}
      ===============================
      Fetch a single event’s details from MySQL using its event_id.
    */
    if (method === "GET" && path.startsWith("/event/")) {
      const eventId = pathParams.event_id;

      const [rows] = await conn.execute("SELECT * FROM events WHERE event_id = ?", [eventId]);
      if (rows.length === 0) {
        return json({ message: "Event not found" }, 404);
      }
      return json(rows[0]);
    }

    /*
      ===============================
      ROUTE: GET /stats/{event_id}
      ===============================
      Retrieve RSVP counts (“Yes” / “No”) from DynamoDB.
      Each count is stored as RESPONSE#Yes or RESPONSE#No items.
    */
    if (method === "GET" && path.startsWith("/stats/")) {
      const eventId = pathParams.event_id;
      
      const responses = ['Yes', 'No'];
      const keys = responses.map(r => ({
        pk: { S: `EVENT#${eventId}` },
        sk: { S: `RESPONSE#${r}` },
      }));

      const result = await dynamo.send(new BatchGetItemCommand({
        RequestItems: { "event-rsvp-counts": { Keys: keys } } // Replace "event-rsvp-counts" with your own DynamoDB table name
      }));

      const items = result.Responses?.["event-rsvp-counts"] || []; // Replace "event-rsvp-counts" with your own DynamoDB table name
      const counts = { Yes: 0, No: 0 };
      for (const item of items) {
        const key = item.sk.S.split("#")[1];
        counts[key] = Number(item.count?.N || 0);
      }

      return json(counts);
    }

    /*
      ===============================
      ROUTE: POST /rsvp
      ===============================
      Record a user’s RSVP (Yes/No) in DynamoDB.
    */
    if (method === "POST" && path === "/rsvp") {
      const { event_id, full_name, email, response } = body;

      if (!event_id || !full_name || !response || !email) {
        return json({
          message: "Missing fields. Email is required to prevent duplicate RSVPs."
        }, 400);
      }

      const now = Date.now();

      try {
        await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: "event-rsvp-counts", // Replace "event-rsvp-counts" with your own DynamoDB table name
                Item: {
                  pk:        { S: `EVENT#${event_id}` },
                  sk:        { S: `RESPONDENT#${email}` },
                  full_name: { S: full_name },
                  email:     { S: email },
                  response:  { S: response },
                  timestamp: { N: String(now) }
                },
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)"
              }
            },
            {
              Update: {
                TableName: "event-rsvp-counts", // Replace "event-rsvp-counts" with your own DynamoDB table name
                Key: {
                  pk: { S: `EVENT#${event_id}` },
                  sk: { S: `RESPONSE#${response}` }
                },
                UpdateExpression: "ADD #count :one",
                ExpressionAttributeNames: { "#count": "count" },
                ExpressionAttributeValues: { ":one": { N: "1" } }
              }
            }
          ]
        }));

        return json({ message: "RSVP recorded!" }, 200);

      } catch (err) {
        if (err.name === "TransactionCanceledException" || err.name === "ConditionalCheckFailedException") {
          return json({
            message: "You have already RSVP'd for this event with this email!",
            code: "DUPLICATE_RSVP"
          }, 409);
        }
        console.error('DynamoDB error:', err);
        return json({ error: err.message }, 500);
      }
    }

    /*
      ===============================
      ROUTE: GET /attendees/{event_id}
      ===============================
      Fetch the list of all respondents for a specific event.
      Optional query param ?response=Yes filters by response type.
    */
    if (method === "GET" && path.startsWith("/attendees/")) {
      const eventId = pathParams.event_id;
      const responseType = queryParams.response; 
      
      let keyCondition = "pk = :pk AND begins_with(sk, :prefix)";
      let expressionValues = {
        ":pk": { S: `EVENT#${eventId}` },
        ":prefix": { S: "RESPONDENT#" }
      };
      
      if (responseType) {
        keyCondition = "pk = :pk AND begins_with(sk, :prefix)";
        expressionValues[":prefix"] = { S: `RESPONDENT#` };
      }

      const result = await dynamo.send(new QueryCommand({
        TableName: "event-rsvp-counts", // Replace "event-rsvp-counts" with your own DynamoDB table name
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: expressionValues,
      }));

      let attendees = result.Items.map(item => ({
        full_name: item.full_name?.S,
        email: item.email?.S,
        response: item.response?.S,
        timestamp: parseInt(item.timestamp?.N)
      }));

      if (responseType) {
        attendees = attendees.filter(attendee => attendee.response === responseType);
      }

      return json(attendees);
    }

    /*
      ===============================
      ROUTE: GET /events
      ===============================
      Retrieve all events from MySQL, sorted by start date.
      This powers your front-end event list.
    */
    if (method === "GET" && path === "/events") {
      const [rows] = await conn.execute(`
        SELECT event_id, title, description, start_at, venue, banner_url, created_at
        FROM events
        ORDER BY start_at ASC
      `);
      return json(rows);
    }

    return json({ message: "Route not found" }, 404);
  } catch (err) {
    console.error('Error:', err);
    return json({ error: err.message }, 500);
  } finally {
    if (conn) await conn.end();
  }
};

function json(data, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With",
      "Access-Control-Allow-Credentials": true
    },
    body: JSON.stringify(data),
  };
}