import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { z } from "zod";

type Role = "READ" | "WRITE" | "ADMIN";

interface ExtendedUser {
  id?: string;
  role?: Role;
}

// GET - List all projects (optionally filtered by category)
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const categoryId = searchParams.get("categoryId");
  const limit = parseInt(searchParams.get("limit") || "50");
  const offset = parseInt(searchParams.get("offset") || "0");

  try {
    const where = categoryId ? { categoryId } : {};

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        include: {
          category: {
            select: { id: true, name: true, slug: true, icon: true },
          },
          owner: {
            select: { id: true, username: true, avatar: true },
          },
          _count: {
            select: { documents: true },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.project.count({ where }),
    ]);

    return NextResponse.json({
      projects: projects.map((p) => ({
        ...p,
        documentCount: p._count.documents,
        _count: undefined,
      })),
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error("Projects list error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la récupération des projets" },
      { status: 500 }
    );
  }
}

// POST - Create a new project
const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  categoryId: z.string().cuid(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const currentUser = session.user as ExtendedUser;

  // Check write permission
  if (!currentUser.role || currentUser.role === "READ") {
    return NextResponse.json(
      { error: "Permission insuffisante pour créer un projet" },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const data = createSchema.parse(body);

    // Verify category exists
    const category = await prisma.category.findUnique({
      where: { id: data.categoryId },
    });
    if (!category) {
      return NextResponse.json(
        { error: "Catégorie non trouvée" },
        { status: 404 }
      );
    }

    // Create project
    const project = await prisma.project.create({
      data: {
        name: data.name,
        description: data.description,
        categoryId: data.categoryId,
        ownerId: currentUser.id!,
        searchReady: "NONE",
      },
      include: {
        category: {
          select: { id: true, name: true, slug: true, icon: true },
        },
        owner: {
          select: { id: true, username: true, avatar: true },
        },
      },
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Paramètres invalides", details: error.errors },
        { status: 400 }
      );
    }
    console.error("Project creation error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la création du projet" },
      { status: 500 }
    );
  }
}
