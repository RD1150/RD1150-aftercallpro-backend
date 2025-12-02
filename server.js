import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// HEALTH CHECK for Render
app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

// ROOT TEST
app.get("/", (req, res) => {
  res.send("AfterCallPro backend is running");
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
