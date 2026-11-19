import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import multer from "multer";
import "dotenv/config";
import Stripe from "stripe";
import createStripeWebhookRouter from "./stripeWebhook.js";

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

//middleware
app.use(cors());


const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // Maximum 5 MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only JPG, PNG and WEBP images are allowed."));
    }

    cb(null, true);
  },
});

const client = new MongoClient(
  `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-hdfbn7t-shard-00-00.lhdjbcn.mongodb.net:27017,ac-hdfbn7t-shard-00-01.lhdjbcn.mongodb.net:27017,ac-hdfbn7t-shard-00-02.lhdjbcn.mongodb.net:27017/?ssl=true&replicaSet=atlas-63srn5-shard-0&authSource=admin`,
);

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
const database = connectedClient.db("pizzahubDB");
const menuItems = database.collection("menuItems");
const users = database.collection("user");
const sessions = database.collection("session");
const orders = database.collection("orders");
const transactions = database.collection("transactions");

app.use(
  "/api/stripe",
  createStripeWebhookRouter({
    stripe,
    users,
  })
);


app.use(express.json());

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const verifyCustomer = (req, res, next) => {
  if (req.user.role !== "customer") {
    return res.status(403).send({
      message: "Forbidden. Customer access only.",
    });
  }

  next();
};

const verifyAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).send({
      success: false,
      message: "Forbidden. Admin access only.",
    });
  }

  next();
};

//Admin-----------------------------------------------------

//admin overview
app.get(
  "/api/admin/overview",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const [
        totalUsers,
        totalVendors,
        totalCustomers,
        totalMenuItems,
        pendingMenuItems,
        totalTransactions,
      ] = await Promise.all([
        users.countDocuments(),
        users.countDocuments({ role: "vendor" }),
        users.countDocuments({ role: "customer" }),
        menuItems.countDocuments(),
        menuItems.countDocuments({ status: "pending" }),
        transactions.countDocuments(),
      ]);

      res.send({
        success: true,
        stats: {
          totalUsers,
          totalVendors,
          totalCustomers,
          totalMenuItems,
          pendingMenuItems,
          totalTransactions,
        },
      });
    } catch (error) {
      console.error("Admin overview error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to load dashboard statistics.",
      });
    }
  }
);


// Get all users
app.get(
  "/api/admin/users",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { search = "", role = "all" } = req.query;

      const query = {};

      // Search by name or email
      if (search.trim()) {
        const searchRegex = {
          $regex: escapeRegex(search.trim()),
          $options: "i",
        };

        query.$or = [
          { name: searchRegex },
          { email: searchRegex },
        ];
      }

      // Filter by role
      if (role !== "all") {
        query.role = role;
      }

      const result = await users
        .find(query, {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            role: 1,
            isBlocked: 1,
            businessName: 1,
            subscriptionPlan: 1,
            createdAt: 1,
          },
        })
        .sort({ createdAt: -1 })
        .toArray();

      res.send({
        success: true,
        total: result.length,
        users: result.map((user) => ({
          ...user,
          _id: String(user._id),
          isBlocked: Boolean(user.isBlocked),
        })),
      });
    } catch (error) {
      console.error("Get users error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to load users.",
      });
    }
  }
);

// Block or Unblock a user
app.patch(
  "/api/admin/users/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isBlocked } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid user ID.",
        });
      }

      if (typeof isBlocked !== "boolean") {
        return res.status(400).send({
          success: false,
          message: "isBlocked must be true or false.",
        });
      }

      // Admin cannot block their own account
      if (String(req.user._id) === id && isBlocked) {
        return res.status(400).send({
          success: false,
          message: "You cannot block your own account.",
        });
      }

      const targetUser = await users.findOne({
        _id: new ObjectId(id),
      });

      if (!targetUser) {
        return res.status(404).send({
          success: false,
          message: "User not found.",
        });
      }

      // Do not allow blocking another admin
      if (targetUser.role === "admin" && isBlocked) {
        return res.status(403).send({
          success: false,
          message: "Admin accounts cannot be blocked.",
        });
      }

      await users.updateOne(
        { _id: targetUser._id },
        {
          $set: {
            isBlocked,
            updatedAt: new Date(),
          },
        }
      );

      res.send({
        success: true,
        message: isBlocked
          ? "User blocked successfully."
          : "User unblocked successfully.",
      });
    } catch (error) {
      console.error("Update user status error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to update user status.",
      });
    }
  }
);


const toObjectId = (id) => {
  if (!id) return null;

  const value = String(id);

  if (ObjectId.isValid(value) && value.length === 24) {
    return new ObjectId(value);
  }

  return null;
};

const findDocumentById = async (collection, id) => {
  if (!id) return null;

  const stringId = String(id);
  const objectId = toObjectId(stringId);

  const conditions = [{ _id: stringId }];

  if (objectId) {
    conditions.push({ _id: objectId });
  }

  return collection.findOne({ $or: conditions });
};

const getCustomerOrderFilter = (customerId) => {
  const stringId = String(customerId);
  const objectId = toObjectId(stringId);

  const conditions = [{ customerId: stringId }];

  if (objectId) {
    conditions.push({ customerId: objectId });
  }

  return { $or: conditions };
};

const normalizeOrderStatus = (status) => {
  return String(status || "pending").toLowerCase();
};

const populateCustomerOrder = async (order) => {
  const itemId = order.itemId || order.menuItemId;
  const vendorId = order.vendorId;

  const [item, vendor] = await Promise.all([
    findDocumentById(menuItems, itemId),
    findDocumentById(users, vendorId),
  ]);

  return {
    ...order,

    _id: String(order._id),

    status: normalizeOrderStatus(order.status),

    item: item
      ? {
          _id: String(item._id),
          itemName: item.itemName,
          images: item.images || [],
          price: item.price,
          category: item.category,
          description: item.description || "",
        }
      : order.item || null,

    vendor: vendor
      ? {
          _id: String(vendor._id),
          name: vendor.name,
          businessName: vendor.businessName || "",
          image: vendor.image || "",
          email: vendor.email,
        }
      : order.vendor || null,

    deliveryDate: order.deliveryDate || null,
    deliveryAddress: order.deliveryAddress || "",
    requestDate: order.createdAt || null,
  };
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

// Create Stripe Checkout Session for Vendor Premium Subscription
app.post(
  "/api/vendor/create-checkout-session",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const vendorId = String(req.user._id);
      const vendorEmail = req.user.email;

      if (
        req.user.subscriptionPlan?.toLowerCase() === "premium"
      ) {
        return res.status(400).send({
          success: false,
          message: "You already have a Premium subscription.",
        });
      }

   
      if (!process.env.STRIPE_PREMIUM_PRICE_ID) {
        return res.status(500).send({
          success: false,
          message: "Stripe Premium price is not configured.",
        });
      }

    
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",

        line_items: [
          {
            price: process.env.STRIPE_PREMIUM_PRICE_ID,
            quantity: 1,
          },
        ],

        customer_email: vendorEmail,

        client_reference_id: vendorId,

        success_url: `${process.env.CLIENT_URL}/vendor-dashboard/subscription?success=true&session_id={CHECKOUT_SESSION_ID}`,

        cancel_url: `${process.env.CLIENT_URL}/vendor-dashboard/subscription?canceled=true`,

        metadata: {
          vendorId,
          vendorEmail,
          plan: "premium",
        },

        subscription_data: {
          metadata: {
            vendorId,
            plan: "premium",
          },
        },
      });

      res.send({
        success: true,
        message: "Checkout session created successfully.",
        url: session.url,
      });
    } catch (error) {
      console.error("Stripe Checkout Error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to create Stripe checkout session.",
      });
    }
  }
);



// Get logged-in vendor subscription information
app.get(
  "/api/vendor/subscription",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      res.send({
        success: true,
        subscriptionPlan: req.user.subscriptionPlan || "free",
        subscriptionStatus: req.user.subscriptionStatus || "inactive",
        subscriptionExpiresAt: req.user.subscriptionExpiresAt || null,
        cancelAtPeriodEnd: req.user.cancelAtPeriodEnd || false,
      });
    } catch (error) {
      console.error("Get subscription error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to load subscription information.",
      });
    }
  }
);


// vendor-----------------------------------------------------
app.post(
  "/api/vendor/menu-items",
  verifyToken,
  verifyVendor,
  upload.single("image"),
  async (req, res) => {
    try {
      const { itemName, category, description, price, location } = req.body;

      if (
        !itemName?.trim() ||
        !category?.trim() ||
        !description?.trim() ||
        !price ||
        !location?.trim()
      ) {
        return res.status(400).send({
          message: "All fields are required.",
        });
      }

      const parsedPrice = Number(price);

      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).send({
          message: "Please enter a valid price.",
        });
      }

      if (!req.file) {
        return res.status(400).send({
          message: "Menu item image is required.",
        });
      }

      const vendorId = String(req.user._id);
      const subscriptionPlan = (
        req.user.subscriptionPlan || "free"
      ).toLowerCase();

      if (subscriptionPlan !== "premium") {
        const activeItemCount = await menuItems.countDocuments({
          vendorId,
          isActive: true,
        });

        if (activeItemCount >= 3) {
          return res.status(403).send({
            message:
              "Free plan allows a maximum of 3 active menu items. Upgrade to Premium for unlimited items.",
          });
        }
      }

      if (!process.env.IMGBB_API_KEY) {
        return res.status(500).send({
          message: "ImgBB API key is not configured.",
        });
      }

      const imageBase64 = req.file.buffer.toString("base64");

      const formData = new URLSearchParams();
      formData.append("image", imageBase64);
      formData.append("name", itemName.trim());

      const imageResponse = await fetch(
        `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
        {
          method: "POST",
          body: formData,
        },
      );

      const imageResult = await imageResponse.json();

      if (!imageResponse.ok || !imageResult.success) {
        console.error("ImgBB upload failed:", imageResult);

        return res.status(500).send({
          message: "Failed to upload menu item image.",
        });
      }

      const imageUrl = imageResult.data.url;

      const newMenuItem = {
        itemName: itemName.trim(),
        category: category.trim(),
        description: description.trim(),
        price: parsedPrice,
        location: location.trim(),

        images: [imageUrl],

        vendorId,

        vendor: {
          name: req.user.name || "",
          businessName: req.user.businessName || "",
          image: req.user.image || "",
        },

        status: "pending",
        isActive: true,

        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await menuItems.insertOne(newMenuItem);

      res.status(201).send({
        success: true,
        message: "Menu item submitted for admin approval.",
        insertedId: result.insertedId,
        item: {
          ...newMenuItem,
          _id: result.insertedId,
        },
      });
    } catch (error) {
      console.error("Failed to add menu item:", error);

      res.status(500).send({
        message: "Failed to add menu item.",
      });
    }
  },
);

// Get only the logged-in vendor's items
app.get(
  "/api/vendor/menu-items",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const vendorId = String(req.user._id);

      const result = await menuItems
        .find({ vendorId })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    } catch (error) {
      console.error("Failed to fetch vendor menu items:", error);

      res.status(500).send({
        message: "Failed to load your menu items.",
      });
    }
  },
);

// Update a menu item
app.patch(
  "/api/vendor/menu-items/:id",
  verifyToken,
  verifyVendor,
  upload.single("image"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid menu item ID.",
        });
      }

      const vendorId = String(req.user._id);

      const existingItem = await menuItems.findOne({
        _id: new ObjectId(id),
        vendorId,
      });

      if (!existingItem) {
        return res.status(404).send({
          message: "Menu item not found.",
        });
      }

      const { itemName, category, description, price, location } = req.body;

      if (
        !itemName?.trim() ||
        !category?.trim() ||
        !description?.trim() ||
        !price ||
        !location?.trim()
      ) {
        return res.status(400).send({
          message: "All fields are required.",
        });
      }

      const parsedPrice = Number(price);

      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).send({
          message: "Please enter a valid price.",
        });
      }

      let images = existingItem.images || [];

      if (req.file) {
        if (!process.env.IMGBB_API_KEY) {
          return res.status(500).send({
            message: "ImgBB API key is not configured.",
          });
        }

        const imageBase64 = req.file.buffer.toString("base64");

        const formData = new URLSearchParams();
        formData.append("image", imageBase64);
        formData.append("name", itemName.trim());

        const imageResponse = await fetch(
          `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
          {
            method: "POST",
            body: formData,
          },
        );

        const imageResult = await imageResponse.json();

        if (!imageResponse.ok || !imageResult.success) {
          return res.status(500).send({
            message: "Failed to upload the new image.",
          });
        }

        images = [imageResult.data.url];
      }

      const updatedItem = {
        itemName: itemName.trim(),
        category: category.trim(),
        description: description.trim(),
        price: parsedPrice,
        location: location.trim(),
        images,

        status: "pending",

        updatedAt: new Date(),
      };

      const result = await menuItems.updateOne(
        {
          _id: new ObjectId(id),
          vendorId,
        },
        {
          $set: updatedItem,
        },
      );

      res.send({
        success: true,
        message: "Menu item updated and submitted for admin approval.",
        modifiedCount: result.modifiedCount,
      });
    } catch (error) {
      console.error("Failed to update menu item:", error);

      res.status(500).send({
        message: "Failed to update menu item.",
      });
    }
  },
);

//Manage availability
app.patch(
  "/api/vendor/menu-items/:id/availability",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid menu item ID.",
        });
      }

      if (typeof isActive !== "boolean") {
        return res.status(400).send({
          message: "isActive must be true or false.",
        });
      }

      const vendorId = String(req.user._id);

      const item = await menuItems.findOne({
        _id: new ObjectId(id),
        vendorId,
      });

      if (!item) {
        return res.status(404).send({
          message: "Menu item not found.",
        });
      }

      const plan = (req.user.subscriptionPlan || "free").toLowerCase();

      if (isActive && !item.isActive && plan !== "premium") {
        const activeCount = await menuItems.countDocuments({
          vendorId,
          isActive: true,
        });

        if (activeCount >= 3) {
          return res.status(403).send({
            message:
              "Free plan allows only 3 active menu items. Upgrade to Premium to activate more.",
          });
        }
      }

      await menuItems.updateOne(
        {
          _id: new ObjectId(id),
          vendorId,
        },
        {
          $set: {
            isActive,
            updatedAt: new Date(),
          },
        },
      );

      res.send({
        success: true,
        message: isActive ? "Menu item activated." : "Menu item deactivated.",
      });
    } catch (error) {
      console.error("Failed to update availability:", error);

      res.status(500).send({
        message: "Failed to update item availability.",
      });
    }
  },
);

// Delete a menu item
app.delete(
  "/api/vendor/menu-items/:id",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid menu item ID.",
        });
      }

      const vendorId = String(req.user._id);

      const result = await menuItems.deleteOne({
        _id: new ObjectId(id),
        vendorId,
      });

      if (result.deletedCount === 0) {
        return res.status(404).send({
          message: "Menu item not found.",
        });
      }

      res.send({
        success: true,
        message: "Menu item deleted successfully.",
      });
    } catch (error) {
      console.error("Failed to delete menu item:", error);

      res.status(500).send({
        message: "Failed to delete menu item.",
      });
    }
  },
);

// vendor dashboard overview
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

//Get vendor orders
app.get("/api/vendor/orders", verifyToken, verifyVendor, async (req, res) => {
  try {
    const vendorId = String(req.user._id);

    const vendorOrders = await orders
      .find({ vendorId })
      .sort({ createdAt: -1 })
      .toArray();

    const detailedOrders = await Promise.all(
      vendorOrders.map(async (order) => {
        const itemId = String(order.itemId);
        const customerId = String(order.customerId);

        const item = ObjectId.isValid(itemId)
          ? await menuItems.findOne({ _id: new ObjectId(itemId) })
          : await menuItems.findOne({ _id: itemId });

        const customer = ObjectId.isValid(customerId)
          ? await users.findOne({ _id: new ObjectId(customerId) })
          : await users.findOne({ _id: customerId });

        return {
          ...order,
          item: item
            ? {
                itemName: item.itemName,
                images: item.images || [],
                price: item.price,
                category: item.category,
              }
            : null,
          customer: customer
            ? {
                name: customer.name,
                email: customer.email,
                image: customer.image || "",
              }
            : null,
        };
      }),
    );

    res.send(detailedOrders);
  } catch (error) {
    console.error("Get vendor orders error:", error);
    res.status(500).send({
      message: "Failed to load customer orders.",
    });
  }
});

//Accept or Reject  vendor own order
app.patch(
  "/api/vendor/orders/:id/status",
  verifyToken,
  verifyVendor,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid order ID.",
        });
      }

      if (!["Accepted", "Rejected"].includes(status)) {
        return res.status(400).send({
          message: "Invalid order status.",
        });
      }

      const vendorId = String(req.user._id);

      const result = await orders.updateOne(
        {
          _id: new ObjectId(id),
          vendorId,
          status: { $in: ["Pending", "pending"] },
        },
        {
          $set: {
            status,
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({
          message:
            "Order not found, does not belong to you, or has already been processed.",
        });
      }

      res.send({
        success: true,
        message: `Order ${status.toLowerCase()} successfully.`,
      });
    } catch (error) {
      console.error("Update order status error:", error);
      res.status(500).send({
        message: "Failed to update order status.",
      });
    }
  },
);

// CUSTOMER DASHBOARD APIs---------------------------------------------------------------

//overview api
app.get(
  "/api/customer/overview",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const customerId = String(req.user._id);

      const customerFilter = getCustomerOrderFilter(customerId);

      const customerOrders = await orders.find(customerFilter).toArray();

      const overview = {
        totalOrders: customerOrders.length,

        pendingOrders: customerOrders.filter(
          (order) => normalizeOrderStatus(order.status) === "pending",
        ).length,

        acceptedOrders: customerOrders.filter(
          (order) => normalizeOrderStatus(order.status) === "accepted",
        ).length,

        rejectedOrders: customerOrders.filter(
          (order) => normalizeOrderStatus(order.status) === "rejected",
        ).length,
      };

      res.send({
        success: true,
        data: overview,
      });
    } catch (error) {
      console.error("Customer overview error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to load customer overview.",
      });
    }
  },
);

// all customer order
app.get(
  "/api/customer/orders",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const customerId = String(req.user._id);

      const customerFilter = getCustomerOrderFilter(customerId);

      const customerOrders = await orders
        .find(customerFilter)
        .sort({ createdAt: -1 })
        .toArray();

      const populatedOrders = await Promise.all(
        customerOrders.map((order) => populateCustomerOrder(order)),
      );

      res.send({
        success: true,
        total: populatedOrders.length,
        data: populatedOrders,
      });
    } catch (error) {
      console.error("Customer orders error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to load customer orders.",
      });
    }
  },
);

//Single cutomer api
app.get(
  "/api/customer/orders/:id",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid order ID.",
        });
      }

      const customerId = String(req.user._id);

      const customerFilter = getCustomerOrderFilter(customerId);

      const order = await orders.findOne({
        $and: [{ _id: new ObjectId(id) }, customerFilter],
      });

      if (!order) {
        return res.status(404).send({
          success: false,
          message: "Order not found.",
        });
      }

      const populatedOrder = await populateCustomerOrder(order);

      res.send({
        success: true,
        data: populatedOrder,
      });
    } catch (error) {
      console.error("Customer order details error:", error);

      res.status(500).send({
        success: false,
        message: "Failed to load order details.",
      });
    }
  },
);

// customer order
app.post(
  "/api/customer/orders",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const { menuItemId, quantity, deliveryAddress, deliveryDate } = req.body;

      if (!menuItemId || !quantity || !deliveryAddress || !deliveryDate) {
        return res.status(400).send({
          success: false,
          message: "All fields are required.",
        });
      }

      if (!ObjectId.isValid(menuItemId)) {
        return res.status(400).send({
          success: false,
          message: "Invalid menu item ID.",
        });
      }

      const orderQuantity = Number(quantity);

      if (
        !Number.isInteger(orderQuantity) ||
        orderQuantity < 1 ||
        orderQuantity > 10
      ) {
        return res.status(400).send({
          success: false,
          message: "Quantity must be between 1 and 10.",
        });
      }

      if (
        typeof deliveryAddress !== "string" ||
        deliveryAddress.trim().length < 10
      ) {
        return res.status(400).send({
          success: false,
          message: "Please provide a valid delivery address.",
        });
      }

      if (
        typeof deliveryDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) ||
        Number.isNaN(Date.parse(`${deliveryDate}T00:00:00`))
      ) {
        return res.status(400).send({
          success: false,
          message: "Please provide a valid delivery date.",
        });
      }

      const menuItem = await menuItems.findOne({
        _id: new ObjectId(menuItemId),
        status: "approved",
        isActive: true,
      });

      if (!menuItem) {
        return res.status(404).send({
          success: false,
          message: "This menu item is unavailable.",
        });
      }

      const totalPrice = menuItem.price * orderQuantity;

      const newOrder = {
        customerId: String(req.user._id),
        vendorId: String(menuItem.vendorId),
        itemId: String(menuItem._id),

        item: {
          itemName: menuItem.itemName,
          images: menuItem.images || [],
          price: menuItem.price,
          category: menuItem.category,
        },

        vendor: {
          name: menuItem.vendor?.name || "",
          businessName: menuItem.vendor?.businessName || "",
          image: menuItem.vendor?.image || "",
        },

        quantity: orderQuantity,
        totalPrice,

        deliveryAddress: deliveryAddress.trim(),
        deliveryDate,

        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await orders.insertOne(newOrder);

      return res.status(201).send({
        success: true,
        message: "Your order has been placed successfully!",
        data: {
          _id: result.insertedId,
          ...newOrder,
        },
      });
    } catch (error) {
      console.error("Create customer order error:", error);

      return res.status(500).send({
        success: false,
        message: "Failed to place order.",
      });
    }
  },
);


// Cancel customer's pending order
app.patch(
  "/api/customer/orders/:id/cancel",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const { id } = req.params

      // 1. Validate order ID
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid order ID.",
        })
      }

      const customerId = String(req.user._id)

      const customerFilter = getCustomerOrderFilter(customerId)

      const result = await orders.updateOne(
        {
          $and: [
            { _id: new ObjectId(id) },
            customerFilter,
            {
              status: {
                $in: ["pending", "Pending", "PENDING"],
              },
            },
          ],
        },
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
        },
      )

      
      if (result.matchedCount === 0) {
        return res.status(404).send({
          success: false,
          message:
            "Order not found, does not belong to you, or is no longer pending.",
        })
      }

    
      return res.send({
        success: true,
        message: "Your order has been cancelled successfully.",
      })
    } catch (error) {
      console.error("Cancel customer order error:", error)

      return res.status(500).send({
        success: false,
        message: "Failed to cancel order.",
      })
    }
  },
)


//listen -----------------------------------------------------------------------------------
app.listen(port, () => {
  console.log(`PizzaHub server is running on port ${port}`);
});

export default app;
