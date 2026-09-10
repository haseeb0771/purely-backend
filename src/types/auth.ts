export interface JwtPayload {
  id: string;
  email: string;
  iat: number;
  exp: number;
}

export interface SanitizedAdmin {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}