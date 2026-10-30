import { json } from '@sveltejs/kit';
import association from './apple-app-site-association.json';

export function GET() {
	return json(association);
}
