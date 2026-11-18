import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 5000;

//middleware
app.use(cors());
app.use(express.json());

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-hdfbn7t-shard-00-00.lhdjbcn.mongodb.net:27017,ac-hdfbn7t-shard-00-01.lhdjbcn.mongodb.net:27017,ac-hdfbn7t-shard-00-02.lhdjbcn.mongodb.net:27017/?ssl=true&replicaSet=atlas-63srn5-shard-0&authSource=admin`);


export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db('pizzahubDB');
const menuItems = database.collection("menuItems");
const users = database.collection("user");

app.get("/", (req, res) => {
  res.send("PizzaHub server is running!");
});

app.get("/menu/featured", async (req, res) => {
  try {
    const result = await menuItems
      .find({
        status: "approved",
        isActive: true,
      })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Failed to get featured menu items:", error);

    res.status(500).send({
      message: "Failed to load featured menu items",
    });
  }
});

app.listen(port, () => {
  console.log(`PizzaHub server is running on port ${port}`);
});

export default app;