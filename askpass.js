"use strict";

const http = require("node:http");
const request = http.request({
  host: "127.0.0.1",
  port: Number(process.env.REMOTE_PROXY_ASKPASS_PORT),
  method: "POST",
  path: "/password",
  headers: { authorization: `Bearer ${process.env.REMOTE_PROXY_ASKPASS_TOKEN}` }
}, (response) => {
  let value = "";
  response.setEncoding("utf8");
  response.on("data", (data) => {
    value += data;
    if (value.length > 16384) response.destroy(new Error("Oversized authentication response"));
  });
  response.on("error", () => { process.exitCode = 1; });
  response.on("end", () => {
    if (response.statusCode !== 200) process.exitCode = 1;
    else process.stdout.write(value + "\n");
  });
});
request.setTimeout(120000, () => request.destroy(new Error("Authentication timed out")));
request.on("error", () => { process.exitCode = 1; });
request.end();
