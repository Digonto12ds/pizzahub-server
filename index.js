import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
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
const sessions = database.collection("session"); 
const orders = database.collection("orders");

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

app.get("/", (req, res) => {
  res.send("PizzaHub server is running!");
});

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send({
        message: "Unauthorized. Please sign in.",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).send({
        message: "Unauthorized.",
      });
    }

    const session = await sessions.findOne({ token });

    if (!session) {
      return res.status(401).send({
        message: "Invalid session. Please sign in again.",
      });
    }

    const expiresAt = new Date(session.expiresAt).getTime();

    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return res.status(401).send({
        message: "Session expired. Please sign in again.",
      });
    }

    const userId = String(session.userId);

    const userConditions = [{ _id: userId }];

    if (ObjectId.isValid(userId)) {
      userConditions.push({
        _id: new ObjectId(userId),
      });
    }

    const user = await users.findOne({
      $or: userConditions,
    });

    if (!user) {
      return res.status(401).send({
        message: "User not found.",
      });
    }

    if (user.isBlocked) {
      return res.status(403).send({
        message: "Your account has been blocked.",
      });
    }

    req.user = user;

    next();
  } catch (error) {
    console.error("Token verification failed:", error);

    res.status(500).send({
      message: "Authentication failed.",
    });
  }
};


const verifyVendor = (req, res, next) => {
  if (req.user.role !== "vendor") {
    return res.status(403).send({
      message: "Forbidden. Vendor access only.",
    });
  }

  next();
};


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

app.get("/menu", async (req, res) => {

  try {
    const { search, category, location } = req.query;

    const query = {
      status: "approved",
      isActive: true,
    };

    if (search) {
      query.itemName = {
        $regex: escapeRegex(search),
        $options: "i",
      };
    }

    if (category && category !== "all") {
      query.category = category;
    }

    if (location) {
      query.location = {
        $regex: escapeRegex(location),
        $options: "i",
      };
    }

    const result = await menuItems
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Failed to fetch menu items:", error);

    res.status(500).send({
      message: "Failed to fetch menu items",
    });
  }
});


app.get("/menu/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid menu item ID",
      });
    }

    const item = await menuItems.findOne({
      _id: new ObjectId(id),
      status: "approved",
      isActive: true,
    });

    if (!item) {
      return res.status(404).send({
        message: "Menu item not found or currently unavailable",
      });
    }

    res.send(item);
  } catch (error) {
    console.error("Failed to fetch menu item:", error);

    res.status(500).send({
      message: "Failed to fetch menu item",
    });
  }
});


app.get("/api/vendor/overview", verifyToken, verifyVendor, async (req, res) => {
  try {

    const vendorMenuItems = database.collection("menuItems");
    const vendorOrders = database.collection("orders");


    const vendorId = String(req.user._id);


    const totalMenuItems = await vendorMenuItems.countDocuments({
      vendorId,
    });

    const activeMenuItems = await vendorMenuItems.countDocuments({
      vendorId,
      isActive: true,
    });

    const pendingOrders = await vendorOrders.countDocuments({
      vendorId,
      status: "pending",
    });

    const acceptedOrders = await vendorOrders.countDocuments({
      vendorId,
      status: "accepted",
    });

    const subscriptionPlan = req.user.subscriptionPlan || "free";

    res.send({
      totalMenuItems,
      activeMenuItems,
      pendingOrders,
      acceptedOrders,
      subscriptionPlan,
    });

  } catch (error) {
    console.error("Failed to load vendor overview:", error);

    res.status(500).send({
      message: "Failed to load vendor dashboard overview.",
    });
  }
});

app.listen(port, () => {
  console.log(`PizzaHub server is running on port ${port}`);
});

export default app;